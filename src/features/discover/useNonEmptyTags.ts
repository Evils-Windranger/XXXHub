import { useMemo } from "react";
import type { TagGroup } from "../../shared/api/types";

export function clearTagVideoCountCache(_lineEpoch?: number): void {
  /* Tag visibility now relies only on synchronous server-provided counts,
     avoiding post-mount background probes that hid post-only tags and caused
     rendered tags to suddenly disappear while browsing. */
}

/**
 * Synchronously filter out tags whose server payload explicitly reports
 * `video_count === 0`. Tags without a count stay visible so they never vanish
 * asynchronously after mount and post-only tags remain accessible.
 */
export function useNonEmptyTags(groups: TagGroup[], _lineEpoch?: number, _refreshNonce?: number): TagGroup[] {
  return useMemo(() => {
    const filtered: TagGroup[] = [];
    for (const group of groups) {
      const visibleTags = (group.tags ?? []).filter((tag) => {
        if (typeof tag.video_count === "number" && Number.isFinite(tag.video_count) && tag.video_count >= 0) {
          return tag.video_count > 0;
        }
        return true;
      });
      if (visibleTags.length > 0) {
        filtered.push({ ...group, tags: visibleTags });
      }
    }
    return filtered;
  }, [groups]);
}
