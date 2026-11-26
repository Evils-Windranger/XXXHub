import demoManifest from "../../../examples/sources/demo-offline/manifest.json";
import demoCode from "../../../examples/sources/demo-offline/source.js?raw";
import type { InstalledSourceSummary, SourceCapabilities } from "../api/api";

export const DEMO_OFFLINE_SOURCE_ID = demoManifest.id;

export function isDemoOfflineSource(
  source?: Pick<InstalledSourceSummary, "id"> | string | null,
): boolean {
  if (!source) return false;
  const id = typeof source === "string" ? source : source.id;
  return id === DEMO_OFFLINE_SOURCE_ID;
}

export function hasPlaybackCapability(caps?: SourceCapabilities | null): boolean {
  if (!caps) return true;
  return Boolean(caps.playback.hls || caps.playback.mp4);
}

export function buildDemoOfflinePackageJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    manifest: {
      ...demoManifest,
      runtime: {
        ...demoManifest.runtime,
        entry: "inline",
      },
    },
    code: demoCode,
    updateUrls: [],
  });
}
