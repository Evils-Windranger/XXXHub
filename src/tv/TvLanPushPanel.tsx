import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type InstalledSourceSummary, type LanPushSession, type TvSyncEnvelope } from "../shared/api/api";
import QrCode from "../shared/ui/QrCode";
import { applyTvSyncEnvelope } from "./tvSync";

export default function TvLanPushPanel({
  onImported,
  onMessage,
}: {
  onImported: (summary?: InstalledSourceSummary) => void;
  onMessage?: (msg: string) => void;
}) {
  const [session, setSession] = useState<LanPushSession | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const lastSeenRef = useRef<string>("");
  const lastSyncIdRef = useRef<number>(0);
  const onImportedRef = useRef(onImported);
  const onMessageRef = useRef(onMessage);
  onImportedRef.current = onImported;
  onMessageRef.current = onMessage;

  useEffect(() => {
    let alive = true;
    let unlistenSource: (() => void) | null = null;
    let unlistenSync: (() => void) | null = null;

    const markSourceKey = (s: InstalledSourceSummary | null | undefined) => {
      if (!s) return;
      lastSeenRef.current = `${s.id}@${s.version}:${s.installedAt}`;
    };

    const handleSyncEnvelope = async (env: TvSyncEnvelope) => {
      if (!alive || !env || env.syncId <= lastSyncIdRef.current) return;
      lastSyncIdRef.current = env.syncId;
      markSourceKey(env.source);
      try {
        const msg = await applyTvSyncEnvelope(env);
        if (!alive) return;
        window.dispatchEvent(new Event("hg:line-changed"));
        window.dispatchEvent(new Event("hg:source-changed"));
        onMessageRef.current?.(msg);
      } catch (e) {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        onMessageRef.current?.(msg);
      } finally {
        if (alive) onImportedRef.current(env.source ?? undefined);
      }
    };

    const handleLegacySource = (s: InstalledSourceSummary) => {
      if (!alive) return;
      const key = `${s.id}@${s.version}:${s.installedAt}`;
      if (lastSeenRef.current === key) return;
      lastSeenRef.current = key;
      window.dispatchEvent(new Event("hg:line-changed"));
      window.dispatchEvent(new Event("hg:source-changed"));
      onMessageRef.current?.(`已导入 ${s.name} v${s.version}`);
      onImportedRef.current(s);
    };

    void api.sourceLanPushStart()
      .then((s) => { if (alive) setSession(s); })
      .catch(() => {});

    void listen<TvSyncEnvelope>("hg:tv-sync-pushed", (e) => {
      if (e.payload) void handleSyncEnvelope(e.payload);
    }).then((fn) => {
      if (alive) unlistenSync = fn;
      else fn();
    }).catch(() => {});

    void listen<InstalledSourceSummary>("hg:source-pushed", (e) => {
      if (e.payload) handleLegacySource(e.payload);
    }).then((fn) => {
      if (alive) unlistenSource = fn;
      else fn();
    }).catch(() => {});

    const timer = window.setInterval(() => {
      void api.sourceLanPushStatus().then((st) => {
        if (!alive) return;
        if (st.lastSync && st.lastSync.syncId > lastSyncIdRef.current) {
          void handleSyncEnvelope(st.lastSync);
          return;
        }
        if (st.lastImported) {
          handleLegacySource(st.lastImported);
        }
      }).catch(() => {});
    }, 2000);

    return () => {
      alive = false;
      window.clearInterval(timer);
      unlistenSync?.();
      unlistenSource?.();
      void api.sourceLanPushStop().catch(() => {});
    };
  }, []);

  const submit = async (override?: string) => {
    const raw = (override ?? draft).trim();
    if (!raw || busy) return;
    setBusy(true);
    setError("");
    try {
      const s = await api.sourceImport(raw, true);
      setDraft("");
      window.dispatchEvent(new Event("hg:line-changed"));
      window.dispatchEvent(new Event("hg:source-changed"));
      onMessageRef.current?.(`已导入 ${s.name} v${s.version}`);
      onImportedRef.current(s);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onMessageRef.current?.(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tv-lan-push">
      {session && (
        <div className="tv-lan-qr">
          <QrCode value={session.url} size={220} quietZone={2} />
          <div className="tv-lan-qr-label">手机扫码配置并同步</div>
          <code className="tv-lan-url">{session.url}</code>
        </div>
      )}
      <div className="tv-lan-form" data-tv-region="source-import" data-tv-columns="1">
        <input
          data-tv-focus="source-input"
          className="tv-lan-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="npm:包名 / 链接 / JSON"
        />
        {error && <p role="alert" className="tv-lan-error">{error}</p>}
        <div className="tv-options tv-lan-actions">
          <button data-tv-focus="source-import-go" disabled={busy || !draft.trim()} onClick={() => void submit()}>
            {busy ? "导入中…" : "导入"}
          </button>
          <button data-tv-focus="source-file" disabled={busy} onClick={() => fileRef.current?.click()}>
            文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.hgsrc,.txt"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then((t) => void submit(t)).catch(() => setError("读取文件失败"));
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}
