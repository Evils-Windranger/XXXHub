import { useEffect, useRef, useState } from "react";
import { api, isMobile, type InstalledSourceSummary, type TvSyncData } from "../../shared/api/api";
import { decodeQrFromFile, decodeQrFromVideo, parseTvLanTarget, type TvLanTarget } from "../../shared/lib/qrDecode";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { useStore } from "../../shared/model/store";
import { autoLineEnabled } from "../../shared/network/autoLine";
import { tr } from "../../shared/i18n";
import { IClose, IScan } from "../../shared/ui/icons";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Modal, Sheet } from "../../shared/ui/ui";

function notifySourceChanged() {
  window.dispatchEvent(new CustomEvent("hg:line-changed"));
  window.dispatchEvent(new CustomEvent("hg:source-changed"));
}

export default function TvQrSyncModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const { favs, postFavs, history, preferHevc, toast } = useStore();
  const { preferences } = useContentPreferences();

  const [tvTarget, setTvTarget] = useState<TvLanTarget | null>(null);
  const [activeSource, setActiveSource] = useState<InstalledSourceSummary | null>(null);
  const [syncSource, setSyncSource] = useState(true);
  const [syncLibrary, setSyncLibrary] = useState(true);
  const [syncPrefs, setSyncPrefs] = useState(true);
  const [lineBase, setLineBase] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [cameraState, setCameraState] = useState<"starting" | "ready" | "error">("starting");
  const [scanPaused, setScanPaused] = useState(false);
  const [scanKey, setScanKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const decodingRef = useRef(false);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    if (!open) {
      stopCamera();
      setTvTarget(null);
      setManualOpen(false);
      setScanPaused(false);
      setManualText("");
      setError("");
      setBusy(false);
      return;
    }
    void api.sourceState().then((s) => {
      const act = s.sources.find((x) => x.active) ?? null;
      setActiveSource(act);
      setSyncSource(Boolean(act));
    }).catch(() => {
      setActiveSource(null);
      setSyncSource(false);
    });
    void api.lineState().then((l) => setLineBase(l.base || "")).catch(() => setLineBase(""));
  }, [open]);

  const handleDecodedRaw = async (rawText: string) => {
    const raw = rawText.trim();
    if (!raw || busy) return;
    setError("");
    const parsed = parseTvLanTarget(raw);
    if (parsed) {
      stopCamera();
      setManualOpen(false);
      setTvTarget(parsed);
      return;
    }
    setBusy(true);
    stopCamera();
    try {
      const summary = await api.sourceImport(raw, true);
      notifySourceChanged();
      toast(tr("已导入 {0} v{1}", summary.name, summary.version), "ok");
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
      setScanPaused(true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open || tvTarget || manualOpen || scanPaused) {
      stopCamera();
      return;
    }
    let alive = true;
    let timer = 0;
    setCameraState("starting");
    setError("");

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (alive) setCameraState("error");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (!alive) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        if (alive) setCameraState("ready");

        const tick = async () => {
          if (!alive) return;
          if (!decodingRef.current && videoRef.current) {
            decodingRef.current = true;
            try {
              if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
              const val = await decodeQrFromVideo(videoRef.current, canvasRef.current);
              if (val && alive) {
                void handleDecodedRaw(val);
                return;
              }
            } catch { /* retry next frame */ }
            finally {
              decodingRef.current = false;
            }
          }
          if (alive) timer = window.setTimeout(() => void tick(), 180);
        };
        timer = window.setTimeout(() => void tick(), 220);
      } catch {
        if (alive) setCameraState("error");
      }
    };

    void start();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      stopCamera();
    };
  }, [open, tvTarget, manualOpen, scanPaused, scanKey]);

  const onFilePick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const val = await decodeQrFromFile(file);
      if (!val) {
        setError(tr("未在图片中识别到二维码"));
        return;
      }
      setBusy(false);
      await handleDecodedRaw(val);
    } catch {
      setError(tr("未在图片中识别到二维码"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const confirmSyncToTv = async () => {
    if (!tvTarget || busy) return;
    const includeSource = syncSource && Boolean(activeSource);
    if (!includeSource && !syncLibrary && !syncPrefs) {
      setError(tr("请至少选择一项要同步的内容"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const sync: TvSyncData = {
        favs: syncLibrary ? favs : [],
        postFavs: syncLibrary ? postFavs : [],
        history: syncLibrary ? history.map((h) => ({ id: h.id, ep: h.ep, t: h.t, dur: h.dur, at: h.at })) : [],
        contentPreferences: syncPrefs
          ? {
              blockedTags: preferences.blockedTags,
              pinnedTags: preferences.pinnedTags,
              paused: preferences.paused,
              hideUntagged: preferences.hideUntagged,
            }
          : null,
        preferHevc: syncPrefs ? preferHevc : null,
        autoLine: syncPrefs ? autoLineEnabled() : null,
        lineBase: syncPrefs && lineBase ? lineBase : null,
      };
      const res = await api.sourceLanPushToTv(tvTarget.url, includeSource, syncLibrary || syncPrefs ? sync : null);
      if (res.legacySourceOnly) {
        toast(tr("已配置视频源，旧版电视暂不支持同步其他数据"), "info");
      } else {
        const parts: string[] = [];
        if (res.sourceName) parts.push(res.sourceName);
        if (res.syncedFavs + res.syncedPostFavs > 0) parts.push(tr("{0} 项收藏", res.syncedFavs + res.syncedPostFavs));
        if (res.syncedHistory > 0) parts.push(tr("{0} 条记录", res.syncedHistory));
        toast(parts.length ? tr("已同步：{0}", parts.join(" · ")) : tr("已完成电视配置与同步"), "ok");
      }
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };

  const libCount = favs.length + postFavs.length;
  const tagCount = preferences.blockedTags.length + preferences.pinnedTags.length;

  const body = (
    <div className="flex flex-col min-h-0 max-h-[82dvh]">
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3.5 border-b border-s3">
        <div className="flex items-center gap-2 min-w-0">
          <IScan size={16} className="text-primary shrink-0" />
          <h2 className="text-[16px] font-bold text-on truncate">{tvTarget ? tr("同步到电视") : tr("扫一扫")}</h2>
        </div>
        <Button onClick={onClose} aria-label={tr("关闭")} className="ios-icon-button"><IClose size={18} /></Button>
      </div>

      <div className="flex-1 min-h-0 scroll-y p-4 space-y-3.5">
        {tvTarget ? (
          <>
            <Surface className="rounded-(--r-md) bg-s2 px-3.5 py-2.5 flex items-center justify-between gap-2">
              <span className="text-[12px] text-mut">{tr("目标电视")}</span>
              <code className="text-[12px] font-mono text-on">{tvTarget.ip}:{tvTarget.port}</code>
            </Surface>

            <Surface className="rounded-(--r-md) bg-s2 divide-y divide-s3">
              <label className="flex items-center justify-between gap-3 p-3.5 cursor-pointer">
                <div className="flex items-center gap-2.5 min-w-0">
                  <input
                    type="checkbox"
                    checked={syncSource && Boolean(activeSource)}
                    disabled={!activeSource || busy}
                    onChange={(e) => setSyncSource(e.target.checked)}
                    className="w-4 h-4 accent-primary shrink-0"
                  />
                  <span className="text-[14px] text-on">{tr("当前视频源")}</span>
                </div>
                <span className="text-[12px] text-mut truncate max-w-[48%]">
                  {activeSource ? `${activeSource.name} v${activeSource.version}` : tr("未设置")}
                </span>
              </label>

              <label className="flex items-center justify-between gap-3 p-3.5 cursor-pointer">
                <div className="flex items-center gap-2.5 min-w-0">
                  <input
                    type="checkbox"
                    checked={syncLibrary}
                    disabled={busy}
                    onChange={(e) => setSyncLibrary(e.target.checked)}
                    className="w-4 h-4 accent-primary shrink-0"
                  />
                  <span className="text-[14px] text-on">{tr("收藏与观看记录")}</span>
                </div>
                <span className="text-[12px] text-mut whitespace-nowrap">
                  {tr("{0} 部收藏 · {1} 条记录", libCount, history.length)}
                </span>
              </label>

              <label className="flex items-center justify-between gap-3 p-3.5 cursor-pointer">
                <div className="flex items-center gap-2.5 min-w-0">
                  <input
                    type="checkbox"
                    checked={syncPrefs}
                    disabled={busy}
                    onChange={(e) => setSyncPrefs(e.target.checked)}
                    className="w-4 h-4 accent-primary shrink-0"
                  />
                  <span className="text-[14px] text-on">{tr("标签偏好与播放设置")}</span>
                </div>
                <span className="text-[12px] text-mut whitespace-nowrap">
                  {tr("{0} 个标签 · 清晰度与线路", tagCount)}
                </span>
              </label>
            </Surface>

            {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}

            <div className="flex items-center gap-2.5 pt-1">
              <Button
                disabled={busy}
                onClick={() => { setError(""); setTvTarget(null); }}
                className="h-10 px-4 rounded-(--r-ctl) bg-s3 text-[13px] font-medium text-on pressable"
              >
                {tr("重新扫码")}
              </Button>
              <Button
                disabled={busy || (!syncSource && !syncLibrary && !syncPrefs)}
                onClick={() => void confirmSyncToTv()}
                className="flex-1 h-10 rounded-(--r-ctl) brand-grad text-[14px] font-semibold text-on-primary pressable disabled:opacity-50"
              >
                {busy ? tr("同步中…") : tr("配置并同步到 TV")}
              </Button>
            </div>
          </>
        ) : manualOpen ? (
          <Surface className="rounded-(--r-md) bg-s2 p-3.5 space-y-3">
            <input
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              placeholder={tr("电视二维码链接 / 视频源链接 / npm:包名")}
              className="w-full h-10 px-3 rounded-(--r-sm) bg-s3 text-[13px] text-on font-mono outline-none"
              autoFocus
            />
            {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
            <div className="flex items-center gap-2">
              <Button
                disabled={busy}
                onClick={() => { setError(""); setManualOpen(false); }}
                className="h-9 px-3.5 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable"
              >
                {tr("返回扫码")}
              </Button>
              <Button
                disabled={busy || !manualText.trim()}
                onClick={() => void handleDecodedRaw(manualText)}
                className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50"
              >
                {busy ? tr("导入中…") : tr("确认")}
              </Button>
            </div>
          </Surface>
        ) : (
          <>
            <div className="relative mx-auto w-full max-w-[290px] aspect-square rounded-(--r-md) overflow-hidden bg-black/80 ring-1 ring-s4 flex items-center justify-center">
              <video ref={videoRef} playsInline muted autoPlay className="w-full h-full object-cover" />
              <div aria-hidden className="pointer-events-none absolute inset-6 border-2 border-primary/70 rounded-xl" />
              {cameraState !== "ready" && (
                <div className="absolute inset-0 flex items-center justify-center p-4 text-center bg-s1/90 text-[13px] text-mut">
                  {cameraState === "starting" ? tr("正在启动相机…") : tr("相机不可用，请从相册选图或手动输入")}
                </div>
              )}
            </div>

            {error && <p role="alert" className="text-[12px] text-danger text-center break-words">{error}</p>}

            <div className="flex items-center justify-center gap-2.5">
              {scanPaused && (
                <Button
                  disabled={busy}
                  onClick={() => { setError(""); setScanPaused(false); setScanKey((k) => k + 1); }}
                  className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable"
                >
                  {tr("重新扫码")}
                </Button>
              )}
              <Button
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13px] font-medium text-on pressable"
              >
                {tr("相册识别")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => { setError(""); setManualOpen(true); }}
                className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13px] font-medium text-on pressable"
              >
                {tr("手动输入")}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void onFilePick(e.target.files?.[0])}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={onClose} label={tvTarget ? tr("同步到电视") : tr("扫一扫")}>{body}</Sheet>
    : <Modal open={open} onClose={onClose} label={tvTarget ? tr("同步到电视") : tr("扫一扫")} width={460}>{body}</Modal>;
}
