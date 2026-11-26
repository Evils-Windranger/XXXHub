import { useState } from "react";
import { api, isMobile } from "../shared/api/api";
import { useStore } from "../shared/model/store";
import { DEMO_OFFLINE_SOURCE_ID, isDemoOfflineSource } from "../shared/lib/demoSource";
import { Button } from "../shared/ui/ios/controls";
import { tr } from "../shared/i18n";

export default function DemoSourceBanner() {
  const { activeSource, toast } = useStore();
  const [busy, setBusy] = useState(false);

  if (!isDemoOfflineSource(activeSource)) return null;

  const removeDemo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.sourceRemove(DEMO_OFFLINE_SOURCE_ID);
      window.dispatchEvent(new CustomEvent("hg:line-changed"));
      window.dispatchEvent(new CustomEvent("hg:source-changed"));
      toast(tr("已移除示例源"), "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : tr("失败"), "info");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 bg-s2/95 border-b border-s3 text-[12px]"
      style={isMobile ? { paddingTop: "calc(var(--sat, 0px) + 4px)" } : undefined}
    >
      <span className="text-dim truncate">{tr("离线示例源 · 仅演示界面")}</span>
      <Button
        disabled={busy}
        onClick={() => void removeDemo()}
        className="shrink-0 h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[11px] font-medium text-on pressable disabled:opacity-50"
      >
        {tr("移除示例源")}
      </Button>
    </div>
  );
}
