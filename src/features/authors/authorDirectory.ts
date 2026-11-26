import { api } from "../../shared/api/api";

export type AuthorItem = {
  id: number;
  name: string;
  followers: number;
  followersKnown?: boolean;
  avatar?: string;
};
export type AuthorDirectory = { items: AuthorItem[]; total: number; supported: boolean };

export const MAX_FOLLOWED_AUTHORS = 24;

const STORAGE_KEY = "hghubx_authors_cache_v1";
const DIRECTORY_PAGE_SIZE = 100;
const MAX_DIRECTORY_PAGES = 10;
const PAGE_CONCURRENCY = 4;

let cache: { key: string; promise: Promise<AuthorDirectory> } | null = null;
let cachedEntry: { key: string; directory: AuthorDirectory } | null = null;
let latestRequestId = 0;
const listeners = new Set<(directory: AuthorDirectory, key: string) => void>();

const positiveId = (value: unknown) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
};

const countValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,/g, "");
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const base = Number(text);
  return Number.isFinite(base) && base >= 0 ? Math.floor(base) : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? value as Record<string, unknown> : null;

export const asAuthor = (value: unknown): AuthorItem | null => {
  const item = asRecord(value);
  if (!item) return null;
  const counts = asRecord(item.counts);
  const id = positiveId(item.id ?? item.user_id);
  const name = [item.nickname, item.name, item.username]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    ?.trim() ?? "";
  if (!id || !name) return null;
  const followers = countValue(
    item.followers ?? item.follower_count ?? item.followers_count ?? item.fans ?? item.fans_count
      ?? counts?.followers ?? counts?.follower_count ?? counts?.followers_count ?? counts?.fans,
  );
  return {
    id,
    name,
    avatar: typeof item.avatar === "string" ? item.avatar : undefined,
    followers: followers ?? 0,
    followersKnown: followers !== null,
  };
};

const merge = (target: Map<number, AuthorItem>, items: AuthorItem[]) => {
  for (const item of items) {
    const previous = target.get(item.id);
    if (!previous
      || (item.followersKnown && !previous.followersKnown)
      || (item.followersKnown === previous.followersKnown && item.followers > previous.followers)) {
      target.set(item.id, item);
    }
  }
};

const sortAuthors = (items: AuthorItem[]) => {
  const known = items.filter(item => item.followersKnown).length;
  // Without follower data, keep the directory's own order: the API already sorted by followers.
  if (!known) return items;
  return items.slice().sort((a, b) => {
    if (a.followersKnown && b.followersKnown) {
      return b.followers - a.followers || a.name.localeCompare(b.name, "zh-CN");
    }
    if (a.followersKnown) return -1;
    if (b.followersKnown) return 1;
    return 0;
  });
};

const pageNumber = (value: unknown): number => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

const pageCount = (pagination: Record<string, unknown> | null): number =>
  pageNumber(pagination?.pages ?? pagination?.total_pages ?? pagination?.page_count ?? pagination?.last_page);

const readStored = (key: string): AuthorDirectory | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as
      { key?: unknown; total?: unknown; supported?: unknown; items?: unknown } | null;
    if (!stored || stored.key !== key || stored.supported !== true || !Array.isArray(stored.items)) return null;
    const items = stored.items.map(asAuthor).filter((item): item is AuthorItem => !!item);
    if (!items.length) return null;
    return { items: sortAuthors(items), total: Math.max(pageNumber(stored.total), items.length), supported: true };
  } catch {
    return null;
  }
};

const writeStored = (key: string, directory: AuthorDirectory) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, ...directory })); } catch { /* Storage may be unavailable. */ }
};

const publish = (key: string, directory: AuthorDirectory) => {
  cachedEntry = { key, directory };
  listeners.forEach(listener => listener(directory, key));
};

export function subscribeAuthors(listener: (directory: AuthorDirectory, key: string) => void) {
  listeners.add(listener);
  if (cachedEntry) listener(cachedEntry.directory, cachedEntry.key);
  return () => { listeners.delete(listener); };
}

async function load(sourceKey: string, requestId: number): Promise<AuthorDirectory> {
  const first = await api.popularAuthors(1, DIRECTORY_PAGE_SIZE);
  if (first?.supported === false) {
    const unsupported: AuthorDirectory = { items: [], total: 0, supported: false };
    if (requestId === latestRequestId) publish(sourceKey, unsupported);
    return unsupported;
  }
  const result = new Map<number, AuthorItem>();
  const firstItems = Array.isArray(first?.items) ? first.items : [];
  merge(result, firstItems.map(asAuthor).filter((item): item is AuthorItem => !!item));
  const pages = Math.min(pageCount(asRecord(first?.pagination)), MAX_DIRECTORY_PAGES);
  const paginationTotal = pageNumber(first?.pagination?.total);

  const buildSnapshot = () => {
    const sorted = sortAuthors([...result.values()]);
    const total = Math.max(paginationTotal, sorted.length);
    return { items: sorted, total, supported: true } as AuthorDirectory;
  };

  if (pages <= 1) {
    const directory = buildSnapshot();
    if (requestId === latestRequestId) {
      writeStored(sourceKey, directory);
      publish(sourceKey, directory);
    }
    return directory;
  }

  // Publish page 1 immediately so the UI renders top authors after a single RTT,
  // then backfill remaining pages concurrently in bounded batches.
  if (requestId === latestRequestId) {
    publish(sourceKey, buildSnapshot());
  }

  for (let start = 2; start <= pages; start += PAGE_CONCURRENCY) {
    if (requestId !== latestRequestId) break;
    const batchPages: number[] = [];
    for (let page = start; page < Math.min(start + PAGE_CONCURRENCY, pages + 1); page += 1) {
      batchPages.push(page);
    }
    const settled = await Promise.allSettled(
      batchPages.map((page) => api.popularAuthors(page, DIRECTORY_PAGE_SIZE)),
    );
    if (requestId !== latestRequestId) break;
    let added = false;
    let stopEarly = false;
    for (const outcome of settled) {
      if (outcome.status !== "fulfilled") continue;
      const next = outcome.value;
      if (next?.supported === false) {
        stopEarly = true;
        continue;
      }
      const batch = Array.isArray(next?.items) ? next.items : [];
      if (!batch.length) {
        stopEarly = true;
        continue;
      }
      merge(result, batch.map(asAuthor).filter((item): item is AuthorItem => !!item));
      added = true;
    }
    if (added && start + PAGE_CONCURRENCY <= pages) {
      publish(sourceKey, buildSnapshot());
    }
    if (stopEarly) break;
  }

  const directory = buildSnapshot();
  if (requestId === latestRequestId) {
    writeStored(sourceKey, directory);
    publish(sourceKey, directory);
  }
  return directory;
}

/**
 * Load the author directory once per source/line key and reuse it across search
 * and the all-authors page. Only an explicit refresh bypasses the cache.
 */
export function loadAuthors(sourceKey: string, force = false): Promise<AuthorDirectory> {
  if (!force && cache?.key === sourceKey) return cache.promise;
  const requestId = ++latestRequestId;
  if (!force) {
    const stored = readStored(sourceKey);
    if (stored) {
      cachedEntry = { key: sourceKey, directory: stored };
      cache = { key: sourceKey, promise: Promise.resolve(stored) };
      return cache.promise;
    }
  }
  const promise = load(sourceKey, requestId);
  cache = { key: sourceKey, promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
  return promise;
}
