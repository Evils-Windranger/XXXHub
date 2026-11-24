import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import App from "./App";
import SourceOnboarding from "./startup/SourceOnboarding";
import { api, type SourceStateSnapshot } from "../shared/api/api";
import { AppProvider } from "../shared/model/store";
import { initAutoLine } from "../shared/network/autoLine";

const Settings = lazy(() => import("../features/settings/Settings"));

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
        <Suspense fallback={null}>
          <Settings wide={window.innerWidth >= 860} onBack={() => { setSettingsOpen(false); refresh(); }} />
        </Suspense>
      );
    }
    return (
      <SourceOnboarding
        state={sourceState}
        onChanged={refresh}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  }
  return <App />;
}

/** Account restore, line probes and content requests begin only after agreement and source activation. */
export default function AcceptedApp() {
  return <AppProvider><SourceGate /></AppProvider>;
}
