import { api, type SourceStateSnapshot } from "../api/api";

const RESUME_COOLDOWN_MS = 60_000;

let inFlight = false;
let lastCheckedAt = 0;

/**
 * Silently check and apply updates for installed video sources that declare
 * `updateUrls`. Never throws or surfaces error notifications to users.
 */
export async function runSilentSourceUpdate(
  snapshot: SourceStateSnapshot | null | "unsupported",
  options?: { force?: boolean },
): Promise<boolean> {
  if (!snapshot || snapshot === "unsupported") return false;
  if (inFlight) return false;
  const now = Date.now();
  if (!options?.force && now - lastCheckedAt < RESUME_COOLDOWN_MS) return false;

  const candidates = snapshot.sources
    .filter((s) => Array.isArray(s.updateUrls) && s.updateUrls.length > 0)
    .sort((a, b) => Number(b.active) - Number(a.active));
  if (!candidates.length) {
    lastCheckedAt = now;
    return false;
  }

  inFlight = true;
  lastCheckedAt = now;
  let anyUpdated = false;
  let activeOriginsChanged = false;

  try {
    for (const src of candidates) {
      const prevOrigins = JSON.stringify(src.origins ?? []);
      try {
        const res = await api.sourceCheckUpdate(src.id);
        if (res?.updated) {
          anyUpdated = true;
          if (src.active && JSON.stringify(res.summary?.origins ?? []) !== prevOrigins) {
            activeOriginsChanged = true;
          }
        }
      } catch {
        // Silent auto-update must never interrupt startup/resume on offline or transient errors.
      }
    }
    if (activeOriginsChanged) {
      window.dispatchEvent(new CustomEvent("hg:line-changed"));
    }
    if (anyUpdated) {
      window.dispatchEvent(new CustomEvent("hg:source-changed"));
    }
  } finally {
    inFlight = false;
  }
  return anyUpdated;
}
