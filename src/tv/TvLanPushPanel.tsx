import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type InstalledSourceSummary, type LanPushSession } from "../shared/api/api";
import QrCode from "../shared/ui/QrCode";

export default function TvLanPushPanel({
  onImported,
  onMessage,
}: {
  onImported: (summary: InstalledSourceSummary) => void;
  onMessage?: (msg: string) => void;
}) {
  const [session, setSession] = useState<LanPushSession | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const lastSeenRef = useRef<string>("");
  const onImportedRef = useRef(onImported);
  const onMessageRef = useRef(onMessage);
  onImportedRef.current = onImported;
  onMessageRef.current = onMessage;

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void api.sourceLanPushStart()
      .then((s) => { if (alive) setSession(s); })
      .catch(() => {});

    void listen<InstalledSourceSummary>("hg:source-pushed", (e) => {
      if (!alive || !e.payload) return;
      const key = `${e.payload.id}@${e.payload.version}:${e.payload.installedAt}`;
      if (lastSeenRef.current === key) return;
      lastSeenRef.current = key;
      window.dispatchEvent(new Event("hg:line-changed"));
      window.dispatchEvent(new Event("hg:source-changed"));
      onImportedRef.current(e.payload);
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    }).catch(() => {});

    const timer = window.setInterval(() => {
      void api.sourceLanPushStatus().then((st) => {
        if (!alive || !st.lastImported) return;
        const s = st.lastImported;
        const key = `${s.id}@${s.version}:${s.installedAt}`;
        if (lastSeenRef.current === key) return;
        lastSeenRef.current = key;
        window.dispatchEvent(new Event("hg:line-changed"));
        window.dispatchEvent(new Event("hg:source-changed"));
        onImportedRef.current(s);
      }).catch(() => {});
    }, 2000);

    return () => {
      alive = false;
      window.clearInterval(timer);
      unlisten?.();
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
    <div style={{ display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" }}>
      {session && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <QrCode value={session.url} size={184} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>手机扫码推送</div>
          <code style={{ fontSize: 12, opacity: 0.72, wordBreak: "break-all", maxWidth: 220, textAlign: "center" }}>
            {session.url}
          </code>
        </div>
      )}
      <div style={{ flex: "1 1 300px", minWidth: 280 }} data-tv-region="source-import" data-tv-columns="1">
        <input
          data-tv-focus="source-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="npm:包名 / 链接 / JSON"
          style={{
            width: "100%",
            padding: "11px 14px",
            borderRadius: 10,
            background: "rgba(255,255,255,.08)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,.16)",
            marginBottom: 12,
          }}
        />
        {error && <p role="alert" style={{ color: "#f87171", marginBottom: 10 }}>{error}</p>}
        <div className="tv-options">
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
