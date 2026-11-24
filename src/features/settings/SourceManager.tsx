import { useEffect, useRef, useState } from "react";
import {
  api, isMobile,
  type InstalledSourceSummary, type SourceStateSnapshot, type SourceTestOutcome,
} from "../../shared/api/api";
import { copyText } from "../../shared/lib/clipboard";
import { useStore } from "../../shared/model/store";
import { Button, Surface, TextArea } from "../../shared/ui/ios/controls";
import { Modal, Sheet, Toggle } from "../../shared/ui/ui";
import { ICheck, IClose, ILink, IRefresh } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";

function notifySourceChanged() {
  window.dispatchEvent(new CustomEvent("hg:line-changed"));
  window.dispatchEvent(new CustomEvent("hg:source-changed"));
}

function signatureLabel(sig: InstalledSourceSummary["signature"]) {
  if (sig.status === "trusted") return `${tr("受信任签名")} · ${sig.keyId || sig.fingerprint}`;
  if (sig.status === "self_signed") return `${tr("自签测试源")} · ${sig.fingerprint}`;
  return tr("未签名");
}

function capabilityTags(caps: InstalledSourceSummary["capabilities"]): string[] {
  const out: string[] = [];
  if (caps.home) out.push(tr("首页"));
  if (caps.search) out.push(tr("搜索"));
  if (caps.catalog?.tags) out.push(tr("标签"));
  if (caps.detail?.episodes) out.push(tr("详情"));
  if (caps.playback?.hls || caps.playback?.mp4) out.push(tr("播放"));
  return out;
}

export default function SourceManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useStore();
  const [state, setState] = useState<SourceStateSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionId, setActionId] = useState("");
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Record<string, SourceTestOutcome>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setState(await api.sourceState());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("加载失败")));
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  const doImport = async (activate: boolean, overrideInput?: string) => {
    const raw = (overrideInput ?? draft).trim();
    if (!raw || busy) return;
    setBusy(true);
    setError("");
    try {
      const summary = await api.sourceImport(raw, activate);
      setDraft("");
      await load();
      if (activate) notifySourceChanged();
      toast(tr("已导入 {0} v{1}", summary.name, summary.version), "ok");
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
      const text = await file.text();
      setDraft(text.trim());
    } catch {
      setError(tr("读取文件失败"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const activate = async (id: string | null, name?: string) => {
    setActionId(id ?? "__builtin__");
    setError("");
    try {
      setState(await api.sourceActivate(id));
      notifySourceChanged();
      toast(id ? tr("已启用视频源：{0}", name || id) : tr("已切回内置默认源"), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
    }
  };

  const runTest = async (id: string) => {
    setActionId(`test:${id}`);
    try {
      const res = await api.sourceTest(id);
      setTests((prev) => ({ ...prev, [id]: res }));
      if (res.ok) {
        toast(tr("测试通过 · {0}ms · {1} 条（{2}）", res.ms, res.itemCount, res.sampleTitle || res.method), "ok");
      } else {
        toast(tr("测试失败：{0}", res.error || tr("失败")), "info");
      }
    } catch (e) {
      toast(tr("测试失败：{0}", e instanceof Error ? e.message : String(e)), "info");
    } finally {
      setActionId("");
    }
  };

  const copyCode = async (id: string) => {
    setActionId(`copy:${id}`);
    try {
      const code = await api.sourceExportShareCode(id);
      await copyText(code);
      toast(tr("口令已复制"), "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "info");
    } finally {
      setActionId("");
    }
  };

  const checkUpdate = async (id: string) => {
    setActionId(`upd:${id}`);
    try {
      const res = await api.sourceCheckUpdate(id);
      await load();
      if (res.updated) {
        notifySourceChanged();
        toast(tr("已更新至 v{0}", res.toVersion), "ok");
      } else {
        toast(tr("已是最新源版本 v{0}", res.fromVersion), "ok");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
    }
  };

  const rollback = async (id: string) => {
    setActionId(`rb:${id}`);
    try {
      const res = await api.sourceRollback(id);
      await load();
      notifySourceChanged();
      toast(tr("已回滚至 v{0}", res.version), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
    }
  };

  const remove = async (id: string) => {
    setActionId(`rm:${id}`);
    try {
      const next = await api.sourceRemove(id);
      setState(next);
      notifySourceChanged();
      toast(tr("已移除视频源"), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
    }
  };

  const body = (
    <div className="flex flex-col min-h-0 max-h-[82dvh]">
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3.5 border-b border-s3">
        <div className="flex items-center gap-2 min-w-0">
          <ILink size={16} className="text-primary shrink-0" />
          <h2 className="text-[16px] font-bold text-on truncate">{tr("视频源管理")}</h2>
        </div>
        <Button onClick={onClose} aria-label={tr("关闭")} className="ios-icon-button"><IClose size={18} /></Button>
      </div>

      <div className="flex-1 min-h-0 scroll-y p-4 space-y-4">
        <Surface className="rounded-(--r-md) bg-s2 p-3.5 space-y-2.5">
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
            className="w-full h-24 p-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on font-mono resize-none"
          />
          {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={busy || !draft.trim()} onClick={() => void doImport(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable disabled:opacity-50">
              {busy ? tr("导入中…") : tr("仅导入")}
            </Button>
            <Button disabled={busy || !draft.trim()} onClick={() => void doImport(true)} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50">
              {busy ? tr("导入中…") : tr("导入并启用")}
            </Button>
          </div>
        </Surface>

        <Surface className="rounded-(--r-md) bg-s2 px-3.5 py-2.5 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-on">{tr("允许自签/测试源")}</div>
            <div className="text-[11px] text-mut mt-0.5">{tr("默认仅允许受信任 Ed25519 签名源；开启后可导入自签或未签名的本地开发源")}</div>
          </div>
          <Toggle
            desktop
            label={tr("允许自签/测试源")}
            on={!!state?.allowUntrusted}
            onChange={(on) => {
              void api.sourceSetAllowUntrusted(on).then(setState).catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}
          />
        </Surface>

        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[12px] font-semibold text-dim">{tr("已安装的视频源")}</span>
            {state?.activeSourceId && (
              <Button disabled={actionId === "__builtin__"} onClick={() => void activate(null)} className="text-[12px] text-primary pressable">
                {tr("切回内置默认源")}
              </Button>
            )}
          </div>

          {!state?.sources.length ? (
            <Surface className="rounded-(--r-md) bg-s2 p-4 text-center text-[12px] text-mut">
              {tr("尚未导入任何视频源；可在上方粘贴 hghubx-src:// 口令或 JSON 试用")}
            </Surface>
          ) : state.sources.map((src) => {
            const t = tests[src.id];
            return (
              <Surface key={src.id} className={`rounded-(--r-md) p-3.5 space-y-2 ${src.active ? "bg-s3/80 ring-1 ring-primary/50" : "bg-s2"}`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[14px] font-semibold text-on truncate">{src.name}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-s4 text-mut font-mono">v{src.version}</span>
                      {src.active && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">
                          <ICheck size={11} /> {tr("当前使用中")}
                        </span>
                      )}
                    </div>
                    {src.description && <p className="text-[12px] text-mut mt-0.5">{src.description}</p>}
                    <div className="text-[11px] text-dim mt-1 break-all">
                      {signatureLabel(src.signature)} · {src.id}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {capabilityTags(src.capabilities).map((tag) => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-s3 text-mut">{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>

                {t && (
                  <div className={`text-[11px] px-2 py-1 rounded ${t.ok ? "bg-mint/15 text-mint" : "bg-danger/15 text-danger"}`}>
                    {t.ok
                      ? tr("测试通过 · {0}ms · {1} 条（{2}）", t.ms, t.itemCount, t.sampleTitle || t.method)
                      : tr("测试失败：{0}", t.error || tr("失败"))}
                  </div>
                )}

                <div className="flex flex-wrap gap-1.5 pt-1">
                  {src.active ? (
                    <Button disabled={!!actionId} onClick={() => void activate(null)} className="h-7 px-2.5 rounded-(--r-sm) bg-s4 text-[12px] text-on pressable">{tr("切回内置默认源")}</Button>
                  ) : (
                    <Button disabled={!!actionId} onClick={() => void activate(src.id, src.name)} className="h-7 px-2.5 rounded-(--r-sm) bg-primary text-[12px] font-medium text-on-primary pressable">{tr("启用")}</Button>
                  )}
                  <Button disabled={!!actionId} onClick={() => void runTest(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">{tr("沙箱测试")}</Button>
                  <Button disabled={!!actionId} onClick={() => void copyCode(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">{tr("复制口令")}</Button>
                  {src.updateUrls.length > 0 && (
                    <Button disabled={!!actionId} onClick={() => void checkUpdate(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable inline-flex items-center gap-1">
                      <IRefresh size={11} /> {tr("检查源更新")}
                    </Button>
                  )}
                  {src.previousVersion && (
                    <Button disabled={!!actionId} onClick={() => void rollback(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">
                      {tr("回滚至 v{0}", src.previousVersion)}
                    </Button>
                  )}
                  <Button disabled={!!actionId} onClick={() => void remove(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-danger pressable ml-auto">{tr("移除")}</Button>
                </div>
              </Surface>
            );
          })}
        </div>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={onClose} label={tr("视频源管理")}>{body}</Sheet>
    : <Modal open={open} onClose={onClose} label={tr("视频源管理")} width={560}>{body}</Modal>;
}
