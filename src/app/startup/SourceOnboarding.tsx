import { useRef, useState } from "react";
import { api, type SourceStateSnapshot } from "../../shared/api/api";
import { useStore } from "../../shared/model/store";
import { Button, Surface, TextArea } from "../../shared/ui/ios/controls";
import { Toggle } from "../../shared/ui/ui";
import { ILink, ISettings, Logo } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";

export default function SourceOnboarding({
  state,
  onChanged,
  onOpenSettings,
}: {
  state: SourceStateSnapshot;
  onChanged: () => void;
  onOpenSettings: () => void;
}) {
  const { toast } = useStore();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const notify = () => {
    window.dispatchEvent(new CustomEvent("hg:line-changed"));
    window.dispatchEvent(new CustomEvent("hg:source-changed"));
    onChanged();
  };

  const doImport = async () => {
    const raw = draft.trim();
    if (!raw || busy) return;
    setBusy(true);
    setError("");
    try {
      const summary = await api.sourceImport(raw, true);
      setDraft("");
      toast(tr("已导入 {0} v{1}", summary.name, summary.version), "ok");
      notify();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setDraft(text.trim());
    } catch {
      toast(tr("读取剪贴板失败，请手动粘贴"), "info");
    }
  };

  const onFilePick = async (file: File | undefined) => {
    if (!file) return;
    try {
      setDraft((await file.text()).trim());
    } catch {
      setError(tr("读取文件失败"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const activateExisting = async (id: string, name: string) => {
    setBusy(true);
    setError("");
    try {
      await api.sourceActivate(id);
      toast(tr("已启用视频源：{0}", name), "ok");
      notify();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-bg flex flex-col overflow-y-auto">
      <div className="shrink-0 flex items-center justify-between px-4 py-3" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <div className="flex items-center gap-2">
          <Logo size={24} />
          <span className="text-[15px] font-bold text-on">HGhubX</span>
        </div>
        <Button onClick={onOpenSettings} className="h-9 px-3 rounded-(--r-ctl) bg-s2 text-[13px] text-on inline-flex items-center gap-1.5 pressable">
          <ISettings size={15} />
          <span>{tr("设置")}</span>
        </Button>
      </div>

      <div className="flex-1 flex items-center justify-center p-4 pb-10">
        <div className="w-full max-w-[520px] space-y-4">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 mx-auto rounded-(--r-md) bg-s2 flex items-center justify-center text-primary">
              <ILink size={24} />
            </div>
            <h1 className="text-[20px] font-bold text-on">{tr("请先导入视频源")}</h1>
            <p className="text-[13px] text-mut leading-relaxed">
              {tr("本客户端为纯播放器与交互壳，不内置任何视频源。请粘贴 hghubx-src:// 口令、JSON、HTTPS 链接或选择本地文件导入。")}
            </p>
          </div>

          <Surface className="rounded-(--r-lg) bg-s2 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-on">{tr("导入视频源")}</span>
              <div className="flex items-center gap-2">
                <Button onClick={pasteClipboard} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">{tr("从剪贴板粘贴")}</Button>
                <Button onClick={() => fileRef.current?.click()} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">{tr("选择本地文件")}</Button>
                <input ref={fileRef} type="file" accept=".json,.hgsrc,.txt" className="hidden" onChange={(e) => void onFilePick(e.target.files?.[0])} />
              </div>
            </div>
            <TextArea
              aria-label={tr("导入视频源")}
              placeholder={tr("粘贴 hghubx-src:// 口令、JSON 或 https:// 链接")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full h-28 p-3 rounded-(--r-sm) bg-s3 text-[12px] text-on font-mono resize-none"
            />
            {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
            <Button
              disabled={busy || !draft.trim()}
              onClick={() => void doImport()}
              className="w-full h-10 rounded-(--r-ctl) brand-grad text-[14px] font-semibold text-on-primary pressable disabled:opacity-50"
            >
              {busy ? tr("导入中…") : tr("导入并启用")}
            </Button>
          </Surface>

          <Surface className="rounded-(--r-md) bg-s2 px-4 py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-on">{tr("允许自签/测试源")}</div>
              <div className="text-[11px] text-mut mt-0.5">{tr("默认仅允许受信任 Ed25519 签名源；开启后可导入自签或未签名的本地开发源")}</div>
            </div>
            <Toggle
              desktop
              label={tr("允许自签/测试源")}
              on={state.allowUntrusted}
              onChange={(on) => {
                void api.sourceSetAllowUntrusted(on).then(onChanged).catch((e) => setError(e instanceof Error ? e.message : String(e)));
              }}
            />
          </Surface>

          {state.sources.length > 0 && (
            <Surface className="rounded-(--r-md) bg-s2 p-3.5 space-y-2">
              <div className="text-[12px] font-semibold text-dim">{tr("已安装的视频源")}</div>
              {state.sources.map((src) => (
                <div key={src.id} className="flex items-center gap-2 py-1.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-on truncate">{src.name} <span className="text-[11px] text-mut font-mono">v{src.version}</span></div>
                    <div className="text-[11px] text-dim truncate">{src.id}</div>
                  </div>
                  <Button disabled={busy} onClick={() => void activateExisting(src.id, src.name)} className="h-8 px-3 rounded-(--r-sm) bg-primary text-[12px] font-medium text-on-primary pressable">
                    {tr("启用")}
                  </Button>
                </div>
              ))}
            </Surface>
          )}
        </div>
      </div>
    </div>
  );
}
