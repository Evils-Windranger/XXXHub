import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type InstalledSourceSummary, type LanPushSession, type TvSyncEnvelope } from "../shared/api/api";
import QrCode from "../shared/ui/QrCode";

type SyncDoneInfo = {
  peer?: string;
  hasSource: boolean;
  hasLib: boolean;
  hasPrefs: boolean;
  summary: string;
};

export default function TvLanPushPanel({
  onImported,
  onMessage,
  compact = false,
}: {
  onImported: (summary?: InstalledSourceSummary) => void;
  onMessage?: (msg: string) => void;
  compact?: boolean;
}) {
  const [session, setSession] = useState<LanPushSession | null>(null);
  const [synced, setSynced] = useState<SyncDoneInfo | null>(null);
  const [startError, setStartError] = useState("");
  const [retryTick, setRetryTick] = useState(0);
  const lastLegacyRef = useRef<string>("");
  const doneTimerRef = useRef<number>(0);
  const onImportedRef = useRef(onImported);
  const onMessageRef = useRef(onMessage);
  onImportedRef.current = onImported;
  onMessageRef.current = onMessage;

  useEffect(() => {
    let alive = true;
    let unlistenLegacy: (() => void) | null = null;
    setStartError("");

    void api.sourceLanPushStart()
      .then((s) => { if (alive) { setSession(s); setStartError(""); } })
      .catch((e) => { if (alive) setStartError(e instanceof Error ? e.message : String(e || "局域网服务启动失败")); });

    const onSyncApplied = (ev: Event) => {
      if (!alive) return;
      const detail = (ev as CustomEvent<{ env: TvSyncEnvelope; summary: string }>).detail;
      if (!detail) return;
      const { env, summary } = detail;
      if (env.source) {
        lastLegacyRef.current = `${env.source.id}@${env.source.version}:${env.source.installedAt}`;
      }
      const hasLib = Boolean(env.sync.favs?.length || env.sync.postFavs?.length || env.sync.history?.length);
      const hasPrefs = Boolean(
        env.sync.contentPreferences ||
        typeof env.sync.preferHevc === "boolean" ||
        typeof env.sync.autoLine === "boolean",
      );
      setSynced({
        peer: env.peerName || "手机",
        hasSource: Boolean(env.source),
        hasLib,
        hasPrefs,
        summary,
      });
      onMessageRef.current?.(summary);
      window.clearTimeout(doneTimerRef.current);
      doneTimerRef.current = window.setTimeout(() => {
        if (!alive) return;
        onImportedRef.current(env.source ?? undefined);
      }, 950);
    };

    window.addEventListener("hg:tv-sync-applied", onSyncApplied);

    void listen<InstalledSourceSummary>("hg:source-pushed", (e) => {
      if (!alive || !e.payload) return;
      const s = e.payload;
      const key = `${s.id}@${s.version}:${s.installedAt}`;
      if (lastLegacyRef.current === key) return;
      lastLegacyRef.current = key;
      window.dispatchEvent(new Event("hg:line-changed"));
      window.dispatchEvent(new Event("hg:source-changed"));
      const msg = `已导入 ${s.name} v${s.version}`;
      setSynced({ peer: "手机", hasSource: true, hasLib: false, hasPrefs: false, summary: msg });
      onMessageRef.current?.(msg);
      window.clearTimeout(doneTimerRef.current);
      doneTimerRef.current = window.setTimeout(() => {
        if (!alive) return;
        onImportedRef.current(s);
      }, 800);
    }).then((fn) => {
      if (alive) unlistenLegacy = fn;
      else fn();
    }).catch(() => {});

    return () => {
      alive = false;
      window.clearTimeout(doneTimerRef.current);
      window.removeEventListener("hg:tv-sync-applied", onSyncApplied);
      unlistenLegacy?.();
      void api.sourceLanPushStop().catch(() => {});
    };
  }, [retryTick]);

  return (
    <div className={`tv-connect-card${compact ? " is-compact" : ""}`}>
        {session?.url && (
          <div className="tv-connect-qr">
            <QrCode value={session.url} size={240} quietZone={2} />
          </div>
        )}

        <div className="tv-connect-info">
          <div className="tv-connect-title">手机扫码或局域网直连</div>

          {session?.code && (
            <div className="tv-pair-code-row">
              <span className="tv-pair-code-label">配对码</span>
              <span className="tv-pair-code">{session.code.split("").join(" ")}</span>
            </div>
          )}

          {synced ? (
            <div className="tv-sync-steps" role="status">
              <span className="tv-sync-done-head">✓ 已连接{synced.peer}</span>
              <div className="tv-sync-pills">
                {synced.hasSource && <span className="tv-sync-pill">✓ 视频源</span>}
                {synced.hasLib && <span className="tv-sync-pill">✓ 片库与进度</span>}
                {synced.hasPrefs && <span className="tv-sync-pill">✓ 偏好设置</span>}
              </div>
            </div>
          ) : startError && !session?.url ? (
            <div role="alert" className="tv-lan-error">{startError}</div>
          ) : (
            <div className="tv-connect-status" role="status">
              <span className="tv-connect-dot" aria-hidden="true" />
              <span>等待手机连接</span>
              {session?.ip && <span className="tv-connect-ip">{session.ip}</span>}
            </div>
          )}

          {startError && !session?.url && (
            <div className="tv-options tv-connect-actions" data-tv-region="source-import" data-tv-columns="1">
              <button data-tv-focus="source-retry-lan" onClick={() => setRetryTick((n) => n + 1)}>
                重试
              </button>
            </div>
          )}
        </div>
      </div>
  );
}
