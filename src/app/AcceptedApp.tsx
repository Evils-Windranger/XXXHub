import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import App from "./App";
import SourceOnboarding from "./startup/SourceOnboarding";
import { api, type SourceStateSnapshot } from "../shared/api/api";
import { usePendingDeepLink } from "../shared/lib/deepLink";
import { AppProvider, useStore } from "../shared/model/store";
import { initAutoLine } from "../shared/network/autoLine";
import { tr } from "../shared/i18n";
import { Button } from "../shared/ui/ios/controls";
import { Modal } from "../shared/ui/ui";

const Settings = lazy(() => import("../features/settings/Settings"));

function DeepLinkImportPrompt({ onImported }: { onImported: () => void }) {
  const { toast } = useStore();
  const [target, clear] = usePendingDeepLink();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!target) return null;
  const confirmImport = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const s = await api.sourceImport(target, true);
      window.dispatchEvent(new CustomEvent("hg:line-changed"));
      window.dispatchEvent(new CustomEvent("hg:source-changed"));
      toast(tr("已导入 {0} v{1}", s.name, s.version), "ok");
      clear();
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={() => { if (!busy) clear(); }} label={tr("导入视频源")} width={420}>
      <div className="p-4 space-y-3">
        <div className="text-[15px] font-bold text-on">{tr("导入视频源")}</div>
        <div className="p-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on font-mono break-all max-h-28 overflow-y-auto">
          {target}
        </div>
        {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
        <div className="flex gap-2">
          <Button disabled={busy} onClick={clear} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable">{tr("取消")}</Button>
          <Button disabled={busy} onClick={() => void confirmImport()} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50">
            {busy ? tr("导入中…") : tr("导入")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SourceGate() {
  const [sourceState, setSourceState] = useState<SourceStateSnapshot | null | "unsupported">(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(() => {
    api.sourceState()
      .then((snap) => {
        if (snap && typeof snap === "object" && Array.isArray(snap.sources)) {
          setSourceState(snap);
        } else {
          // Mocked browser fixtures that don't implement source_state proceed directly.
          setSourceState("unsupported");
        }
      })
      .catch(() => setSourceState("unsupported"));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("hg:source-changed", refresh);
    return () => window.removeEventListener("hg:source-changed", refresh);
  }, [refresh]);

  const readyForApp =
    sourceState === "unsupported" ||
    (sourceState !== null && Boolean(sourceState.activeSourceId));

  useEffect(() => {
    if (readyForApp) initAutoLine();
  }, [readyForApp]);

  if (sourceState === null) return null;
  if (sourceState !== "unsupported" && !sourceState.activeSourceId) {
    if (settingsOpen) {
      return (
        <>
          <Suspense fallback={null}>
            <Settings wide={window.innerWidth >= 860} onBack={() => { setSettingsOpen(false); refresh(); }} />
          </Suspense>
          <DeepLinkImportPrompt onImported={refresh} />
        </>
      );
    }
    return (
      <>
        <SourceOnboarding
          state={sourceState}
          onChanged={refresh}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <DeepLinkImportPrompt onImported={refresh} />
      </>
    );
  }
  return (
    <>
      <App />
      <DeepLinkImportPrompt onImported={refresh} />
    </>
  );
}

/** Account restore, line probes and content requests begin only after agreement and source activation. */
export default function AcceptedApp() {
  return <AppProvider><SourceGate /></AppProvider>;
}
