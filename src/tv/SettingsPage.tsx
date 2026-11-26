import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, APP_VERSION, hostOf, type LineState, type LineItem, type PairedPeerSummary, type ProxyState, type SourceStateSnapshot } from "../shared/api/api";
import { autoLineEnabled, setAutoLine, pickLine } from "../shared/network/autoLine";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { UsageAgreementText } from "../shared/ui/UsageAgreement";
import { setTvDisplay, useTvDisplay } from "./display";
import { lockTvSession, useTvPin } from "./pinLock";
import { setPlaybackPreferences, usePlaybackPreferences } from "./preferences";
import { TvPinSettingsModal, type TvPinModalMode } from "./TvPinGate";
import TvLanPushPanel from "./TvLanPushPanel";
import { useTv } from "./TvProvider";
import { TvModal } from "./ui";
import {
  cancelTvUpdateDownload,
  checkTvUpdate,
  downloadAndInstallTvUpdate,
  formatApkSize,
  installCachedTvUpdate,
  resetCachedTvUpdate,
  summarizeReleaseNotes,
  useTvUpdater,
} from "./updater";

const groups=["播放偏好","画面边距","启动密码","标签屏蔽","手机同步","视频源","线路","网络","缓存","关于"];

function formatSyncTime(ts: number) {
  if (!ts) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diff < 60) return "刚刚同步";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前同步`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前同步`;
  return `${Math.floor(diff / 86400)} 天前同步`;
}

export default function SettingsPage(){
  const { activeSource, sourceState } = useTv();
  const allowLines = sourceState === "unsupported" || Boolean(activeSource?.capabilities.lines);
  const visibleGroups = allowLines ? groups : groups.filter(g => g !== "线路");
  const [group,setGroup]=useState(visibleGroups[0]),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[agreement,setAgreement]=useState(false),[pinModal,setPinModal]=useState<TvPinModalMode|null>(null);
  const [lines,setLines]=useState<LineState|null>(null),[proxy,setProxy]=useState<ProxyState|null>(null),[auto,setAuto]=useState(autoLineEnabled);
  const [sources,setSources]=useState<SourceStateSnapshot|null>(null);
  const [peers,setPeers]=useState<PairedPeerSummary[]>([]);
  const [cacheInfo,setCacheInfo]=useState<{usedBytes:number;limitBytes:number}|null>(null);
  const [mirrors,setMirrors]=useState<LineItem[]>([]),[mirrorError,setMirrorError]=useState("");
  const operation = useRef(false);
  const preferences=useContentPreferences(),display=useTvDisplay(),playback=usePlaybackPreferences(),pin=useTvPin(),updater=useTvUpdater();
  useEffect(()=>{
    if(!visibleGroups.includes(group))setGroup(visibleGroups[0]);
  },[allowLines,group,visibleGroups]);
  useEffect(()=>{
    let current=true, generation=0;
    const refresh=()=>{const token=++generation;setAuto(autoLineEnabled());void Promise.all([allowLines?api.lineState():Promise.resolve(null),api.proxyState(),api.sourceState().catch(()=>null)]).then(([l,p,s])=>{if(current&&token===generation){setLines(l);setProxy(p);if(s)setSources(s);}}).catch(e=>{if(current&&token===generation)setMessage(String(e));});};
    refresh();
    const events=["hg:line-changed","hg:proxy-changed","hg:auto-line-changed","hg:source-changed"];
    events.forEach(name=>window.addEventListener(name,refresh));
    return()=>{current=false;events.forEach(name=>window.removeEventListener(name,refresh));};
  },[allowLines]);
  const readMirrors=async()=>{if(!allowLines)return;setMirrorError("");try{const result=await api.lineMirrors();setMirrors(result.items);}catch(e){setMirrorError(String(e));}};
  const refreshSources=()=>{void api.sourceState().then(setSources).catch(()=>{});};
  const refreshPeers=()=>{void api.tvPeerList().then(setPeers).catch(()=>{});};
  const refreshCache=()=>{void api.cacheStats().then(s=>{if(s&&typeof s.usedBytes==="number")setCacheInfo(s);}).catch(()=>{});};
  useEffect(()=>{
    if(group==="线路"&&allowLines)void readMirrors();
    if(group==="视频源")refreshSources();
    if(group==="缓存")refreshCache();
    if(group==="手机同步"){
      refreshPeers();
      let unlisten: (() => void) | null = null;
      void listen("hg:tv-peers-changed", () => refreshPeers()).then(fn => { unlisten = fn; }).catch(()=>{});
      return () => { unlisten?.(); };
    }
  },[group,allowLines]);
  const run=async(action:()=>Promise<unknown>,success="已保存")=>{if(operation.current)return;operation.current=true;setBusy(true);setMessage("");try{await action();if(success)setMessage(success);}catch(e){setMessage(String(e));}finally{operation.current=false;setBusy(false);}};
  const availableLines=[...new Map([...(lines?.fixed||[]),...mirrors].map(line=>[line.url,line])).values()];
  const hasUpdate=Boolean(updater.info?.has_update);
  const apkSize=formatApkSize(updater.info?.asset?.size);
  const notes=summarizeReleaseNotes(updater.info?.notes);
  const prog=updater.progress;
  const progressText=prog
    ?prog.phase==="connecting"
      ?`正在连接下载节点${prog.source?` ${prog.source}`:""}（第 ${prog.attempt}/${prog.totalAttempts} 个）…`
      :prog.phase==="verifying"
        ?"正在进行 SHA-256 完整性校验…"
        :`正在下载更新包${prog.percent!=null?` ${prog.percent}%`:""}${prog.downloaded?` · ${formatApkSize(prog.downloaded)}${prog.total?` / ${formatApkSize(prog.total)}`:""}`:""}${prog.source?` · 来源 ${prog.source}`:""}`
    :"";
  const primaryUpdateLabel=updater.status==="checking"?"正在检查更新…"
    :updater.status==="downloading"?"取消下载"
    :updater.status==="downloaded"?`安装已下载更新${updater.info?.latest?` v${updater.info.latest}`:""}`
    :updater.status==="available"&&updater.info?.asset?.url?`一键更新至 v${updater.info.latest}`
    :"检查更新";
  const onPrimaryUpdate=()=>{
    if(updater.status==="downloading"){cancelTvUpdateDownload();return;}
    if(updater.status==="downloaded"){installCachedTvUpdate();return;}
    if(updater.status==="available"&&updater.info?.asset?.url){void downloadAndInstallTvUpdate();return;}
    void checkTvUpdate(true);
  };
  return <><header className="tv-page-heading"><h1>设置</h1></header><div className="tv-settings">
    <div className="tv-settings-groups" data-tv-region="settings-groups" data-tv-columns="1">{visibleGroups.map(name=><button data-tv-focus={`settings-${name}`} aria-pressed={group===name} key={name} onClick={()=>{setGroup(name);setMessage("");}}>{name}{name==="关于"&&hasUpdate&&<span className="tv-badge">新版</span>}</button>)}</div>
    <section className="tv-settings-options"><h2>{group}</h2><p role="status">{busy?"正在应用…":message||preferences.storageError}</p>
      {group==="播放偏好"&&<><h3>默认倍速</h3><div className="tv-options" data-tv-region="default-rate">{[0.75,1,1.25,1.5,2].map(rate=><button role="radio" aria-checked={playback.rate===rate} data-tv-focus={`rate-${rate}`} key={rate} onClick={()=>{try{setPlaybackPreferences({rate});}catch(e){setMessage(String(e));}}}>{rate}×</button>)}</div><h3>默认清晰度</h3><div className="tv-options" data-tv-region="default-quality">{(["main","hevc"] as const).map(quality=><button key={quality} role="radio" aria-checked={playback.quality===quality} data-tv-focus={`quality-${quality}`} onClick={()=>{try{setPlaybackPreferences({quality});}catch(e){setMessage(String(e));}}}>{quality==="main"?"标准":"高清 HEVC（如有）"}</button>)}</div><button role="switch" aria-checked={playback.autoplayNext} data-tv-focus="autoplay-next" onClick={()=>{try{setPlaybackPreferences({autoplayNext:!playback.autoplayNext});}catch(e){setMessage(String(e));}}}>作品内自动续集：{playback.autoplayNext?"开启":"关闭"}</button></>}
      {group==="画面边距"&&<><p>背景和视频始终铺满屏幕。边距只作用于文字与控件。</p>{([['horizontal','左右'],['top','顶部'],['bottom','底部']] as const).map(([key,label])=><div className="tv-setting-row" data-tv-region={`margin-${key}`} key={key}><span>{label} {display[key]}%</span><button data-tv-focus={`margin-${key}-minus`} disabled={display[key]<=0} aria-label={`减少${label}边距`} onClick={()=>{if(!setTvDisplay({...display,[key]:display[key]-1}))setMessage("边距已生效，保存失败，请重试");}}>−</button><button data-tv-focus={`margin-${key}-plus`} disabled={display[key]>=12} aria-label={`增加${label}边距`} onClick={()=>{if(!setTvDisplay({...display,[key]:display[key]+1}))setMessage("边距已生效，保存失败，请重试");}}>＋</button></div>)}<button data-tv-focus="margin-reset" onClick={()=>{if(!setTvDisplay({horizontal:3,top:3,bottom:3}))setMessage("边距已生效，保存失败，请重试");}}>恢复 3% 边距</button></>}
      {group==="启动密码"&&<><p>开启后，每次打开软件都需输入 4 位数字 PIN 码后才能进入。</p><div data-tv-region="pin-options" data-tv-columns="1"><button role="switch" aria-checked={pin.enabled} data-tv-focus="pin-toggle" onClick={()=>{setMessage("");setPinModal(pin.enabled?"disable":"setup");}}>启动密码锁：{pin.enabled?"开启":"关闭"}</button>{pin.enabled&&<button data-tv-focus="pin-change" onClick={()=>{setMessage("");setPinModal("change");}}>修改 4 位密码</button>}{pin.enabled&&<button data-tv-focus="pin-lock-now" onClick={()=>lockTvSession()}>立即锁定软件</button>}</div></>}
      {group==="标签屏蔽"&&<><div data-tv-region="tag-switches" data-tv-columns="1"><button role="switch" aria-checked={!preferences.preferences.paused} data-tv-focus="block-paused" onClick={()=>preferences.setPaused(!preferences.preferences.paused)}>内容屏蔽：{preferences.preferences.paused?"关闭":"开启"}</button><button role="switch" aria-checked={preferences.preferences.hideUntagged} disabled={preferences.preferences.paused} data-tv-focus="hide-untagged" onClick={()=>preferences.setHideUntagged(!preferences.preferences.hideUntagged)}>隐藏无标签内容：{preferences.preferences.hideUntagged?"开启":"关闭"}</button></div><p>在作品详情的“更多”中选择标签屏蔽。选择下方标签可以解除。</p><div className="tv-tags" data-tv-region="blocked-tags" data-tv-columns="3">{preferences.preferences.blockedTags.map(tag=><button key={tag} data-tv-focus={`blocked-${tag}`} onClick={()=>preferences.unblockTag(tag)}>解除：{tag}</button>)}</div></>}
      {group==="手机同步"&&<>
        <TvLanPushPanel
          compact
          onImported={()=>{refreshSources();refreshPeers();}}
          onMessage={setMessage}
        />
        <h3>已配对设备</h3>
        {!peers.length ? (
          <p>配对一次后，手机同 Wi-Fi 下无需再扫码，可随时双向同步收藏与进度。</p>
        ) : (
          <div data-tv-region="peer-list" data-tv-columns="1">
            {peers.map(peer=><div key={peer.pairId} className="tv-setting-row">
              <span>{peer.name} <small>({[peer.lastIp, formatSyncTime(peer.lastSyncedAt)].filter(Boolean).join(" · ")})</small></span>
              <button data-tv-focus={`peer-rm-${peer.pairId}`} disabled={busy} onClick={()=>void run(async()=>{setPeers(await api.tvPeerRemove(peer.pairId));},"已解除配对")}>解除配对</button>
            </div>)}
          </div>
        )}
      </>}
      {group==="视频源"&&<>
        <p>当前：{sources?.activeSourceId?(sources.sources.find(s=>s.id===sources.activeSourceId)?.name||sources.activeSourceId):"未设置"}</p>
        <div className="tv-options" data-tv-region="source-actions">
          <button data-tv-focus="src-go-sync" onClick={()=>{setMessage("");setGroup("手机同步");}}>手机扫码导入</button>
        </div>
        <div data-tv-region="source-list" data-tv-columns="1" style={{marginTop:10}}>
          {(sources?.sources||[]).map(src=><div key={src.id} className="tv-setting-row" style={{flexWrap:"wrap",gap:8,marginTop:8}}>
            <span>{src.name} v{src.version}{src.active?" · 使用中":""}</span>
            {src.active
              ?<button data-tv-focus={`src-off-${src.id}`} disabled={busy} onClick={()=>void run(async()=>{setSources(await api.sourceActivate(null));window.dispatchEvent(new Event("hg:line-changed"));},"已停用")}>停用</button>
              :<button data-tv-focus={`src-act-${src.id}`} disabled={busy} onClick={()=>void run(async()=>{setSources(await api.sourceActivate(src.id));window.dispatchEvent(new Event("hg:line-changed"));},`已启用 ${src.name}`)}>启用</button>}
            <button data-tv-focus={`src-test-${src.id}`} disabled={busy} onClick={()=>void run(async()=>{const r=await api.sourceTest(src.id);setMessage(r.ok?`测试通过 · ${r.ms}ms · ${r.itemCount} 条`:`测试失败：${r.error||"失败"}`);},"")}>测试</button>
            {src.updateUrls.length>0&&<button data-tv-focus={`src-upd-${src.id}`} disabled={busy} onClick={()=>void run(async()=>{const r=await api.sourceCheckUpdate(src.id);setSources(await api.sourceState());setMessage(r.updated?`已更新至 v${r.toVersion}`:`已是最新 v${r.fromVersion}`);},"")}>更新</button>}
            {src.previousVersion&&<button data-tv-focus={`src-rb-${src.id}`} disabled={busy} onClick={()=>void run(async()=>{const r=await api.sourceRollback(src.id);setSources(await api.sourceState());window.dispatchEvent(new Event("hg:line-changed"));setMessage(`已回滚至 v${r.version}`);},"")}>回滚</button>}
            <button data-tv-focus={`src-rm-${src.id}`} disabled={busy} onClick={()=>void run(async()=>{setSources(await api.sourceRemove(src.id));window.dispatchEvent(new Event("hg:line-changed"));},"已移除")}>移除</button>
          </div>)}
        </div>
      </>}
      {group==="线路"&&allowLines&&<><p>当前：{lines?(hostOf(lines.base)||"未设置"):"正在读取"}</p><div data-tv-region="line-options" data-tv-columns="1"><button disabled={busy} role="switch" aria-checked={auto} data-tv-focus="auto-line" onClick={()=>void run(async()=>{await setAutoLine(!auto);setAuto(!auto);})}>自动选线：{auto?"开启":"关闭"}</button><button data-tv-focus="pick-line" disabled={busy||!auto} onClick={()=>void run(async()=>{await pickLine("tv-settings",true);setLines(await api.lineState());})}>重新检测可用线路</button>{mirrorError&&<p role="status">{mirrorError}</p>}<button data-tv-focus="refresh-mirrors" disabled={busy} onClick={()=>void run(readMirrors,"镜像线路已更新")}>刷新镜像线路</button>{availableLines.map(line=><button key={line.url} data-tv-focus={`line-${line.url}`} role="radio" aria-checked={lines?.base===line.url} disabled={busy} onClick={()=>void run(async()=>{await setAutoLine(false);setAuto(false);await api.lineSet(line.url);window.dispatchEvent(new Event("hg:line-changed"));setLines(await api.lineState());})}>{line.name||hostOf(line.url)}</button>)}</div></>}
      {group==="网络"&&<><p>使用电视系统代理，或直接连接。网络设置影响当前应用。</p><div data-tv-region="proxy-options" data-tv-columns="1">{(["system","off"] as const).map(mode=><button key={mode} disabled={busy} role="radio" aria-checked={proxy?.mode===mode} data-tv-focus={`proxy-${mode}`} onClick={()=>void run(async()=>{setProxy(await api.proxySet(mode,""));window.dispatchEvent(new Event("hg:proxy-changed"));})}>{mode==="system"?"跟随系统代理":"直连"}</button>)}</div></>}
      {group==="缓存"&&<><p>{cacheInfo&&cacheInfo.usedBytes>0?`当前已缓存约 ${formatApkSize(cacheInfo.usedBytes)}，`:""}超过 {Math.round((cacheInfo?.limitBytes??120*1024*1024)/(1024*1024))} MB 时会自动清理较早缓存。手动清理不会影响本地片库、同步记录与偏好设置。</p><button data-tv-focus="clear-cache" disabled={busy} onClick={()=>void run(async()=>{await api.clearCache();resetCachedTvUpdate();refreshCache();},"缓存已清理，片库和偏好已保留")}>清理缓存</button></>}
      {group==="关于"&&<><h3>HGhubX TV {APP_VERSION}</h3>
        <div className="tv-update-card">
          {updater.status==="idle"&&<p>支持电视端应用内一键更新（内置加速节点自动回退与 SHA-256 完整性校验）。</p>}
          {updater.status==="checking"&&<p>正在检查 GitHub Release 新版本…</p>}
          {updater.status==="up-to-date"&&<p>当前已是最新版本（v{updater.info?.latest||APP_VERSION}）。</p>}
          {(updater.status==="available"||updater.status==="downloaded")&&updater.info&&<>
            <p className="tv-update-title">发现新版本 v{updater.info.latest}{apkSize?` · ${apkSize}`:""}{updater.info.asset?.name?`（${updater.info.asset.name}）`:"（暂无适配本机架构的 APK）"}</p>
            {notes.length>0&&<ul className="tv-update-notes">{notes.map((line,idx)=><li key={idx}>{line}</li>)}</ul>}
          </>}
          {updater.status==="downloading"&&<>
            <p className="tv-update-title">{progressText}</p>
            <div className="tv-update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={prog?.percent??0}><div className="tv-update-bar-fill" style={{width:`${Math.max(4,prog?.percent??4)}%`}}/></div>
          </>}
          {updater.installerMessage&&<p className="tv-update-hint">{updater.installerMessage}</p>}
          {updater.error&&<p className="tv-update-error" role="alert">{updater.error}</p>}
        </div>
        <div className="tv-options" data-tv-region="about-actions">
          <button className="tv-update-primary" data-tv-focus="update-action" disabled={updater.status==="checking"} onClick={onPrimaryUpdate}>{primaryUpdateLabel}</button>
          {(updater.status==="available"||updater.status==="downloaded")&&<button data-tv-focus="update-recheck" onClick={()=>void checkTvUpdate(true)}>重新检查</button>}
          <button data-tv-focus="read-agreement" onClick={()=>setAgreement(true)}>查看使用协议</button>
        </div>
      </>}
    </section></div>
    {agreement&&<TvModal id="about-agreement" title="使用协议" onClose={()=>setAgreement(false)}><div data-tv-focus="about-agreement-text" data-tv-scroll tabIndex={0} className="tv-agreement-review"><UsageAgreementText/></div></TvModal>}{pinModal&&<TvPinSettingsModal mode={pinModal} onClose={()=>setPinModal(null)} onDone={msg=>{setPinModal(null);setMessage(msg);}}/>}</>;
}
