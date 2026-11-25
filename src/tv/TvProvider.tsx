import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type TvSyncEnvelope } from "../shared/api/api";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { autoLineEnabled, initAutoLine } from "../shared/network/autoLine";
import { initializeLibrary, listLibrary, setFavorite, saveProgress, subscribeLibrary, clearHistory } from "./library";
import { contentKey, type TvContent, type TvLibraryEntry, type TvProgress } from "./model";
import { usePlaybackPreferences } from "./preferences";
import { setCatalogSource } from "./search/catalog";
import { applyTvSyncEnvelope } from "./tvSync";

type TvState = {
  source: string;
  sourceKey: string;
  library: TvLibraryEntry[];
  ready: boolean;
  error: string;
  syncNotice: string;
  retry: () => void;
  toggleFavorite: (content: TvContent) => Promise<void>;
  progress: (value: TvProgress) => Promise<void>;
  clearHistory: () => Promise<void>;
};

const Context = createContext<TvState | null>(null);

export function TvProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [library, setLibrary] = useState<TvLibraryEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [retryId, setRetry] = useState(0);

  const prefs = useContentPreferences();
  const playback = usePlaybackPreferences();

  const alive = useRef(false);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const sourceGeneration = useRef(0);
  const reloadGeneration = useRef(0);
  const pendingFavorites = useRef(new Set<string>());
  const lastSyncIdRef = useRef(0);
  const noticeTimerRef = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    const items = await listLibrary();
    if (alive.current && generation === reloadGeneration.current) setLibrary(items);
  }, []);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    void (async () => {
      try {
        setError("");
        const generation = sourceGeneration.current;
        const boot = await api.boot();
        if (disposed) return;
        await initializeLibrary(boot.pending_migration_identity);
        if (disposed) return;
        await reload();
        if (disposed) return;
        if (generation === sourceGeneration.current) {
          setCatalogSource(boot.base);
          setSource(boot.base);
        }
        setReady(true);
      } catch (err) {
        if (!disposed) setError(String(err));
      }
    })();
    return () => {
      disposed = true;
      alive.current = false;
      reloadGeneration.current++;
      window.clearTimeout(noticeTimerRef.current);
    };
  }, [retryId, reload]);

  useEffect(() => {
    if (ready && source) initAutoLine();
  }, [ready, source]);

  useEffect(() => subscribeLibrary(() => { void reload().catch((e) => setError(String(e))); }), [reload]);

  useEffect(() => {
    let disposed = false;
    const changed = () => {
      const current = ++sourceGeneration.current;
      // Invalidate the old response eligibility before reading the actual source.
      setCatalogSource("");
      setSource("");
      setEpoch((e) => e + 1);
      void api.lineState().then((state) => {
        if (!disposed && current === sourceGeneration.current) {
          setCatalogSource(state.base);
          setSource(state.base);
        }
      }).catch((e) => {
        if (!disposed && current === sourceGeneration.current) setError(String(e));
      });
    };
    window.addEventListener("hg:line-changed", changed);
    window.addEventListener("hg:proxy-changed", changed);
    return () => {
      disposed = true;
      sourceGeneration.current++;
      window.removeEventListener("hg:line-changed", changed);
      window.removeEventListener("hg:proxy-changed", changed);
    };
  }, []);

  // Global always-on TV peer daemon + incoming bidirectional sync listener
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const handleSync = async (env: TvSyncEnvelope) => {
      if (disposed || !env || env.syncId <= lastSyncIdRef.current) return;
      lastSyncIdRef.current = env.syncId;
      try {
        const summary = await applyTvSyncEnvelope(env);
        if (disposed) return;
        await reload();
        if (disposed) return;
        window.dispatchEvent(new Event("hg:line-changed"));
        window.dispatchEvent(new Event("hg:source-changed"));
        window.dispatchEvent(new CustomEvent("hg:tv-sync-applied", { detail: { env, summary } }));
        const msg = env.peerName ? `${env.peerName} · ${summary}` : summary;
        setSyncNotice(msg);
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = window.setTimeout(() => {
          if (!disposed) setSyncNotice("");
        }, 4200);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    };

    void api.tvPeerStart("HGhubX TV").catch(() => {});
    void api.sourceLanPushStatus().then((st) => {
      if (!disposed && st.lastSync && st.lastSync.syncId > lastSyncIdRef.current) {
        void handleSync(st.lastSync);
      }
    }).catch(() => {});

    void listen<TvSyncEnvelope>("hg:tv-sync-pushed", (e) => {
      if (e.payload) void handleSync(e.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ready, reload]);

  // Keep Rust's in-memory TV snapshot up to date so any paired phone can pull TV state anytime.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      const favs: number[] = [];
      const postFavs: number[] = [];
      const history: { id: number; ep: number; t: number; dur: number; at: number }[] = [];
      for (const item of library) {
        if (item.favorite) {
          if (item.content.kind === "video") favs.push(item.content.id);
          else postFavs.push(item.content.id);
        }
        if (item.progress && item.content.kind === "video") {
          history.push({
            id: item.content.id,
            ep: Math.max(1, Number(item.progress.part) || 1),
            t: item.progress.seconds,
            dur: item.progress.duration,
            at: item.progress.updatedAt,
          });
        }
      }
      void api.tvPeerUpdateSnapshot({
        favs,
        postFavs,
        history,
        contentPreferences: {
          blockedTags: prefs.preferences.blockedTags,
          pinnedTags: prefs.preferences.pinnedTags,
          paused: prefs.preferences.paused,
          hideUntagged: prefs.preferences.hideUntagged,
        },
        preferHevc: playback.quality === "hevc",
        autoLine: autoLineEnabled(),
        lineBase: source || null,
      }).catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [ready, library, source, prefs.preferences, playback.quality]);

  const toggleFavorite = useCallback(async (content: TvContent) => {
    const key = contentKey(content);
    if (pendingFavorites.current.has(key)) return;
    pendingFavorites.current.add(key);
    try {
      const entry = libraryRef.current.find((item) => item.key === key);
      await setFavorite(content, !entry?.favorite);
      await reload();
    } catch (e) {
      setError(`收藏保存失败：${String(e)}`);
      throw e;
    } finally {
      pendingFavorites.current.delete(key);
    }
  }, [reload]);

  const progress = useCallback(async (value: TvProgress) => {
    try {
      await saveProgress(value.content, value);
    } catch (e) {
      setError(`进度保存失败：${String(e)}`);
      throw e;
    }
  }, []);

  return (
    <Context.Provider
      value={{
        source,
        sourceKey: `${source}@${epoch}`,
        library,
        ready,
        error,
        syncNotice,
        retry: () => setRetry((r) => r + 1),
        toggleFavorite,
        progress,
        clearHistory,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useTv() {
  const value = useContext(Context);
  if (!value) throw new Error("TvProvider missing");
  return value;
}
