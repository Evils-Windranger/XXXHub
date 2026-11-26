//! Ephemeral pairing + persistent LAN peer server and client for TV ↔ phone bidirectional sync.
//!
//! Security boundary:
//! - TCP listener & UDP discovery (`17655`) bind only on explicit TV app startup; zero external URLs proxied.
//! - Unpaired pairing routes (`GET /`, `POST /push`, `POST /sync`, `POST /pair`) are accessible ONLY
//!   while TV pairing mode is active and valid `?t=` token or `?code=` 4-digit PIN is presented (constant-time).
//! - Persistent sync (`POST /peer/sync`) authenticates paired peers via constant-time `(X-HG-Pair-Id, X-HG-Pair-Key)`.
//! - Secret `pair_key` stays strictly inside Rust (`peer_store`) and never enters WebView, UDP, or logs.
//! - Outgoing requests connect directly over TCP ONLY to RFC1918 IPv4 addresses with port >= 1024.

use super::commands::import_source_raw;
use super::manifest::{decode_package_input, semver_gt, MAX_PACKAGE_JSON_BYTES};
use super::peer_store::{const_time_eq, now_secs, random_b64url, PairedPeer, PairedPeerSummary};
use super::store::InstalledSourceSummary;
use super::{peer_store_arc, store_arc};
use once_cell::sync::Lazy;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket as TokioUdpSocket};
use tokio::sync::oneshot;

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_SYNC_BODY_BYTES: usize = 1024 * 1024;
const MAX_CLIENT_RESP_BYTES: usize = 2 * 1024 * 1024;
const MAX_SYNC_ITEMS: usize = 5000;
const MAX_BLOCKED_TAGS: usize = 200;
const MAX_PINNED_TAGS: usize = 24;
const MAX_TAG_CHARS: usize = 64;
const PREFERRED_TCP_PORT: u16 = 17656;
const DISCOVERY_UDP_PORT: u16 = 17655;
const DISCOVERY_MAGIC: &[u8] = b"HGHUBX_DISCOVER_V1";
const PAIRING_TTL: Duration = Duration::from_secs(600);
const CONN_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_CODE_FAILURES: u8 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPushSession {
    pub url: String,
    pub ip: String,
    pub port: u16,
    pub token: String,
    pub code: String,
    pub device_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TvSyncHistoryItem {
    pub id: i64,
    pub ep: i64,
    pub t: f64,
    pub dur: f64,
    pub at: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TvSyncContentPrefs {
    pub blocked_tags: Vec<String>,
    pub pinned_tags: Vec<String>,
    pub paused: bool,
    pub hide_untagged: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TvSyncData {
    pub favs: Vec<i64>,
    pub post_favs: Vec<i64>,
    pub history: Vec<TvSyncHistoryItem>,
    pub content_preferences: Option<TvSyncContentPrefs>,
    pub prefer_hevc: Option<bool>,
    pub auto_line: Option<bool>,
    pub line_base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TvSyncEnvelope {
    pub sync_id: u64,
    pub source: Option<InstalledSourceSummary>,
    pub sync: TvSyncData,
    pub peer_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TvSyncRequest {
    source_raw: Option<String>,
    sync: Option<TvSyncData>,
    peer_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TvPairRequest {
    peer_device_id: String,
    peer_name: String,
    source_raw: Option<String>,
    sync: Option<TvSyncData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TvPeerSyncRequest {
    source_raw: Option<String>,
    source_id: Option<String>,
    source_version: Option<String>,
    sync: Option<TvSyncData>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredTv {
    pub device_id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub pairing: bool,
    pub pair_id: Option<String>,
    pub last_synced_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TvBidirectionalSyncResult {
    pub ok: bool,
    pub pair_id: Option<String>,
    pub tv_name: String,
    pub tv_ip: String,
    pub source_name: Option<String>,
    pub source_version: Option<String>,
    pub pushed_favs: usize,
    pub pushed_post_favs: usize,
    pub pushed_history: usize,
    pub tv_sync: TvSyncData,
    pub imported_source_from_tv: Option<InstalledSourceSummary>,
    pub legacy_source_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPushClientResult {
    pub ok: bool,
    pub source_name: Option<String>,
    pub source_version: Option<String>,
    pub synced_favs: usize,
    pub synced_post_favs: usize,
    pub synced_history: usize,
    pub legacy_source_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPushStatus {
    pub active: bool,
    pub pairing: bool,
    pub url: Option<String>,
    pub code: Option<String>,
    pub last_imported: Option<InstalledSourceSummary>,
    pub last_sync: Option<TvSyncEnvelope>,
}

#[derive(Debug, Clone)]
struct PairingSession {
    token: String,
    code: String,
    failed_attempts: u8,
    expires_at: Instant,
}

struct TvPeerServer {
    ip: String,
    port: u16,
    name: String,
    pairing: Arc<Mutex<Option<PairingSession>>>,
    tv_snapshot: Arc<Mutex<TvSyncData>>,
    last_imported: Arc<Mutex<Option<InstalledSourceSummary>>>,
    last_sync: Arc<Mutex<Option<TvSyncEnvelope>>>,
    _stop_tx: oneshot::Sender<()>,
}

static SERVER: Lazy<Mutex<Option<TvPeerServer>>> = Lazy::new(|| Mutex::new(None));
static NEXT_SYNC_ID: AtomicU64 = AtomicU64::new(1);

fn detect_lan_ipv4() -> String {
    for target in ["192.168.1.1:80", "10.0.0.1:80", "1.1.1.1:80"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    if let IpAddr::V4(ip) = addr.ip() {
                        if !ip.is_loopback() && !ip.is_unspecified() {
                            return ip.to_string();
                        }
                    }
                }
            }
        }
    }
    Ipv4Addr::LOCALHOST.to_string()
}

fn generate_code() -> Result<String, String> {
    let mut bytes = [0u8; 4];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "生成配对码失败".to_string())?;
    let val = u32::from_le_bytes(bytes) % 10_000;
    Ok(format!("{val:04}"))
}

fn clean_device_name(raw: &str, fallback: &str) -> String {
    let clean: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(40)
        .collect();
    if clean.is_empty() {
        fallback.to_string()
    } else {
        clean
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    !a.is_empty() && const_time_eq(a.as_bytes(), b.as_bytes())
}

fn is_rfc1918_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

fn push_page_html(token: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>HGhubX</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;background:#071218;color:#f3f6f8;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px}}
.card{{width:100%;max-width:440px;background:#102029;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:18px}}
.top{{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}}
h1{{margin:0;font-size:17px;font-weight:700}}
.btn-s{{height:30px;padding:0 12px;border-radius:8px;border:0;background:#1c313d;color:#f3f6f8;font-size:12px;cursor:pointer}}
textarea{{width:100%;height:120px;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:#0a1820;color:#f3f6f8;font:13px/1.5 ui-monospace,monospace;resize:none;outline:none}}
textarea:focus{{border-color:#26c6da}}
.go{{margin-top:12px;width:100%;height:42px;border-radius:10px;border:0;background:linear-gradient(135deg,#26c6da,#00acc1);color:#041218;font-size:15px;font-weight:700;cursor:pointer}}
.go:disabled{{opacity:.5}}
#msg{{margin:10px 0 0;font-size:13px;min-height:18px;word-break:break-word}}
.ok{{color:#4ade80}}.err{{color:#f87171}}
</style>
</head>
<body>
<div class="card">
  <div class="top">
    <h1>HGhubX</h1>
    <button class="btn-s" type="button" onclick="document.getElementById('f').click()">文件</button>
    <input id="f" type="file" accept=".json,.hgsrc,.txt" hidden>
  </div>
  <textarea id="t" placeholder="链接 / hghubx-src:// 口令 / JSON" autofocus></textarea>
  <button id="go" class="go" type="button">推送</button>
  <p id="msg"></p>
</div>
<script>
const tok={token_json},t=document.getElementById('t'),go=document.getElementById('go'),msg=document.getElementById('msg');
document.getElementById('f').onchange=async e=>{{const f=e.target.files[0];if(f)t.value=(await f.text()).trim();e.target.value='';}};
go.onclick=async()=>{{
  const v=t.value.trim();if(!v)return;
  go.disabled=true;msg.className='';msg.textContent='推送中…';
  try{{
    const r=await fetch('/push?t='+encodeURIComponent(tok),{{method:'POST',headers:{{'Content-Type':'text/plain;charset=utf-8'}},body:v}});
    const d=await r.json();
    if(d.ok){{msg.className='ok';msg.textContent='已导入 '+d.name+' v'+d.version;t.value='';}}
    else{{msg.className='err';msg.textContent=d.error||'失败';}}
  }}catch(e){{msg.className='err';msg.textContent=String(e);}}
  finally{{go.disabled=false;}}
}};
</script>
</body>
</html>"#,
        token_json = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".into())
    )
}

async fn write_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

fn query_param(target: &str, name: &str) -> Option<String> {
    let (_, query) = target.split_once('?')?;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

async fn read_http_request(
    stream: &mut TcpStream,
) -> Result<(String, String, HashMap<String, String>, Vec<u8>), &'static str> {
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        let n = stream.read(&mut tmp).await.map_err(|_| "read_err")?;
        if n == 0 {
            return Err("eof");
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err("header_too_large");
        }
    };

    let head = std::str::from_utf8(&buf[..header_end]).map_err(|_| "bad_utf8")?;
    let mut lines = head.split("\r\n");
    let first = lines.next().ok_or("empty_req")?;
    let mut parts = first.split_whitespace();
    let method = parts.next().ok_or("bad_req")?.to_ascii_uppercase();
    let target = parts.next().ok_or("bad_req")?.to_string();
    let path = target.split('?').next().unwrap_or("");
    let is_large = matches!(path, "/sync" | "/pair" | "/peer/sync");
    let max_body = if is_large {
        MAX_SYNC_BODY_BYTES
    } else {
        MAX_PACKAGE_JSON_BYTES
    };
    let too_large_err = if is_large {
        "body_too_large_sync"
    } else {
        "body_too_large"
    };

    let mut headers = HashMap::new();
    let mut content_length: usize = 0;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            if key == "content-length" {
                content_length = val.parse::<usize>().map_err(|_| "bad_len")?;
                if content_length > max_body {
                    return Err(too_large_err);
                }
            }
            headers.insert(key, val);
        }
    }

    let mut body = buf[(header_end + 4)..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp).await.map_err(|_| "read_err")?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
        if body.len() > max_body {
            return Err(too_large_err);
        }
    }
    body.truncate(content_length);
    Ok((method, target, headers, body))
}

fn sanitize_ids(items: Vec<i64>) -> Vec<i64> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(items.len().min(MAX_SYNC_ITEMS));
    for id in items {
        if id > 0 && seen.insert(id) {
            out.push(id);
            if out.len() >= MAX_SYNC_ITEMS {
                break;
            }
        }
    }
    out
}

fn sanitize_tags(items: Vec<String>, max_count: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(items.len().min(max_count));
    for raw in items {
        let trimmed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() || trimmed.chars().count() > MAX_TAG_CHARS {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            out.push(trimmed);
            if out.len() >= max_count {
                break;
            }
        }
    }
    out
}

fn sanitize_sync_data(data: TvSyncData) -> TvSyncData {
    let favs = sanitize_ids(data.favs);
    let post_favs = sanitize_ids(data.post_favs);
    let mut seen_hist = HashSet::new();
    let mut history = Vec::with_capacity(data.history.len().min(MAX_SYNC_ITEMS));
    for row in data.history {
        if row.id > 0
            && row.ep >= 1
            && row.t.is_finite()
            && row.t >= 0.0
            && row.dur.is_finite()
            && row.dur >= 0.0
            && row.at.is_finite()
            && row.at >= 0.0
            && seen_hist.insert(row.id)
        {
            history.push(row);
            if history.len() >= MAX_SYNC_ITEMS {
                break;
            }
        }
    }
    let content_preferences = data.content_preferences.map(|p| TvSyncContentPrefs {
        blocked_tags: sanitize_tags(p.blocked_tags, MAX_BLOCKED_TAGS),
        pinned_tags: sanitize_tags(p.pinned_tags, MAX_PINNED_TAGS),
        paused: p.paused,
        hide_untagged: p.hide_untagged,
    });
    let line_base = data
        .line_base
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && crate::network_policy::parse_target(s).is_ok())
        .map(str::to_string);
    TvSyncData {
        favs,
        post_favs,
        history,
        content_preferences,
        prefer_hevc: data.prefer_hevc,
        auto_line: data.auto_line,
        line_base,
    }
}

fn verify_pairing_token(pairing: &Mutex<Option<PairingSession>>, target: &str) -> bool {
    let Some(tok) = query_param(target, "t") else {
        return false;
    };
    let mut guard = pairing.lock().unwrap_or_else(|e| e.into_inner());
    let Some(active) = guard.as_ref() else {
        return false;
    };
    if active.expires_at <= Instant::now() {
        *guard = None;
        return false;
    }
    constant_time_eq(&tok, &active.token)
}

fn verify_pairing_token_or_code(
    pairing: &Mutex<Option<PairingSession>>,
    target: &str,
) -> Result<(), (&'static str, &'static str)> {
    let mut guard = pairing.lock().unwrap_or_else(|e| e.into_inner());
    let Some(active) = guard.as_mut() else {
        return Err(("403 Forbidden", "配对已过期，请在电视端打开扫码页"));
    };
    if active.expires_at <= Instant::now() {
        *guard = None;
        return Err(("403 Forbidden", "配对已过期，请在电视端重新扫码"));
    }
    if let Some(tok) = query_param(target, "t") {
        if constant_time_eq(&tok, &active.token) {
            return Ok(());
        }
        return Err(("403 Forbidden", "配对二维码已失效，请在电视端刷新"));
    }
    if let Some(code) = query_param(target, "code") {
        if constant_time_eq(&code, &active.code) {
            return Ok(());
        }
        active.failed_attempts = active.failed_attempts.saturating_add(1);
        if active.failed_attempts >= MAX_CODE_FAILURES {
            *guard = None;
            return Err(("429 Too Many Requests", "配对码错误次数过多，请在电视端刷新"));
        }
        return Err(("403 Forbidden", "配对码错误"));
    }
    Err(("403 Forbidden", "缺少配对凭证"))
}

struct AppliedSync {
    imported_source: Option<InstalledSourceSummary>,
    favs: usize,
    post_favs: usize,
    history: usize,
    prefs: bool,
    line: bool,
}

async fn apply_incoming_sync(
    app: &AppHandle,
    last_imported: &Mutex<Option<InstalledSourceSummary>>,
    last_sync: &Mutex<Option<TvSyncEnvelope>>,
    source_raw: Option<String>,
    sync: Option<TvSyncData>,
    peer_name: Option<String>,
    skip_same_or_older_source: bool,
) -> Result<AppliedSync, String> {
    let mut imported_summary: Option<InstalledSourceSummary> = None;
    if let Some(raw) = source_raw {
        let should_import = if skip_same_or_older_source {
            match (decode_package_input(&raw), store_arc().active_package()) {
                (Ok(cand), Some(active)) if cand.manifest.id == active.manifest.id => {
                    semver_gt(&cand.manifest.version, &active.manifest.version)
                }
                _ => true,
            }
        } else {
            true
        };
        if should_import {
            let summary = import_source_raw(&raw, true).await?;
            if let Ok(mut guard) = last_imported.lock() {
                *guard = Some(summary.clone());
            }
            imported_summary = Some(summary);
        }
    }

    let clean_sync = sync.map(sanitize_sync_data).unwrap_or_default();
    let mut line_applied = false;
    if let Some(ref url) = clean_sync.line_base {
        if crate::net::set_base(url).is_ok() {
            crate::net::refresh_client();
            line_applied = true;
        }
    }

    let favs = clean_sync.favs.len();
    let post_favs = clean_sync.post_favs.len();
    let history = clean_sync.history.len();
    let prefs = clean_sync.content_preferences.is_some()
        || clean_sync.prefer_hevc.is_some()
        || clean_sync.auto_line.is_some();

    let envelope = TvSyncEnvelope {
        sync_id: NEXT_SYNC_ID.fetch_add(1, Ordering::Relaxed),
        source: imported_summary.clone(),
        sync: clean_sync,
        peer_name,
    };
    if let Ok(mut guard) = last_sync.lock() {
        *guard = Some(envelope.clone());
    }
    let _ = app.emit("hg:tv-sync-pushed", &envelope);
    if let Some(ref summary) = imported_summary {
        let _ = app.emit("hg:source-pushed", summary);
    }

    Ok(AppliedSync {
        imported_source: imported_summary,
        favs,
        post_favs,
        history,
        prefs,
        line: line_applied,
    })
}

fn active_package_raw_and_version() -> (Option<String>, Option<String>, Option<String>) {
    let Some(pkg) = store_arc().active_package() else {
        return (None, None, None);
    };
    let id = pkg.manifest.id.clone();
    let ver = pkg.manifest.version.clone();
    let raw = serde_json::to_string(&pkg).ok();
    (raw, Some(id), Some(ver))
}

#[derive(Clone)]
struct ClientCtx {
    app: AppHandle,
    tv_name: String,
    pairing: Arc<Mutex<Option<PairingSession>>>,
    tv_snapshot: Arc<Mutex<TvSyncData>>,
    last_imported: Arc<Mutex<Option<InstalledSourceSummary>>>,
    last_sync: Arc<Mutex<Option<TvSyncEnvelope>>>,
}

async fn handle_client(mut stream: TcpStream, peer_addr: SocketAddr, ctx: ClientCtx) {
    let parsed = match tokio::time::timeout(CONN_TIMEOUT, read_http_request(&mut stream)).await {
        Ok(Ok(req)) => req,
        Ok(Err("body_too_large")) => {
            write_response(&mut stream, "413 Payload Too Large", "application/json; charset=utf-8", r#"{"ok":false,"error":"内容超过 512 KB"}"#.as_bytes()).await;
            return;
        }
        Ok(Err("body_too_large_sync")) => {
            write_response(&mut stream, "413 Payload Too Large", "application/json; charset=utf-8", r#"{"ok":false,"error":"同步数据超过 1 MB"}"#.as_bytes()).await;
            return;
        }
        _ => {
            write_response(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", b"Bad Request").await;
            return;
        }
    };

    let (method, target, headers, body) = parsed;
    let path = target.split('?').next().unwrap_or("");
    let peer_ip = match peer_addr.ip() {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => v6.to_string(),
    };

    match (method.as_str(), path) {
        ("GET", "/") => {
            if !verify_pairing_token(&ctx.pairing, &target) {
                write_response(&mut stream, "403 Forbidden", "text/plain; charset=utf-8", b"Forbidden").await;
                return;
            }
            let token = query_param(&target, "t").unwrap_or_default();
            let html = push_page_html(&token);
            write_response(&mut stream, "200 OK", "text/html; charset=utf-8", html.as_bytes()).await;
        }
        ("POST", "/push") => {
            if !verify_pairing_token(&ctx.pairing, &target) {
                write_response(&mut stream, "403 Forbidden", "text/plain; charset=utf-8", b"Forbidden").await;
                return;
            }
            let raw = String::from_utf8_lossy(&body).trim().to_string();
            if raw.is_empty() {
                write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", r#"{"ok":false,"error":"内容为空"}"#.as_bytes()).await;
                return;
            }
            match import_source_raw(&raw, true).await {
                Ok(summary) => {
                    if let Ok(mut guard) = ctx.last_imported.lock() {
                        *guard = Some(summary.clone());
                    }
                    let _ = ctx.app.emit("hg:source-pushed", &summary);
                    let resp = serde_json::json!({
                        "ok": true,
                        "id": summary.id,
                        "name": summary.name,
                        "version": summary.version,
                    })
                    .to_string();
                    write_response(&mut stream, "200 OK", "application/json; charset=utf-8", resp.as_bytes()).await;
                }
                Err(err) => {
                    let resp = serde_json::json!({ "ok": false, "error": err }).to_string();
                    write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", resp.as_bytes()).await;
                }
            }
        }
        ("POST", "/sync") => {
            if !verify_pairing_token(&ctx.pairing, &target) {
                write_response(&mut stream, "403 Forbidden", "application/json; charset=utf-8", r#"{"ok":false,"error":"配对已过期，请刷新二维码"}"#.as_bytes()).await;
                return;
            }
            let req: TvSyncRequest = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => {
                    write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", r#"{"ok":false,"error":"同步请求格式无效"}"#.as_bytes()).await;
                    return;
                }
            };
            let source_raw = req
                .source_raw
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            if source_raw.is_none() && req.sync.is_none() {
                write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", r#"{"ok":false,"error":"没有可同步的数据"}"#.as_bytes()).await;
                return;
            }
            match apply_incoming_sync(
                &ctx.app,
                &ctx.last_imported,
                &ctx.last_sync,
                source_raw,
                req.sync,
                req.peer_name.map(|s| clean_device_name(&s, "手机")),
                false,
            )
            .await
            {
                Ok(applied) => {
                    let resp = serde_json::json!({
                        "ok": true,
                        "source": applied.imported_source,
                        "synced": {
                            "favs": applied.favs,
                            "postFavs": applied.post_favs,
                            "history": applied.history,
                            "prefs": applied.prefs,
                            "line": applied.line,
                        },
                    })
                    .to_string();
                    write_response(&mut stream, "200 OK", "application/json; charset=utf-8", resp.as_bytes()).await;
                }
                Err(err) => {
                    let resp = serde_json::json!({ "ok": false, "error": err }).to_string();
                    write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", resp.as_bytes()).await;
                }
            }
        }
        ("POST", "/pair") => {
            if let Err((status, msg)) = verify_pairing_token_or_code(&ctx.pairing, &target) {
                let resp = serde_json::json!({ "ok": false, "error": msg }).to_string();
                write_response(&mut stream, status, "application/json; charset=utf-8", resp.as_bytes()).await;
                return;
            }
            let req: TvPairRequest = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => {
                    write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", r#"{"ok":false,"error":"配对请求格式无效"}"#.as_bytes()).await;
                    return;
                }
            };
            let peer_device_id = req.peer_device_id.trim().to_string();
            if peer_device_id.is_empty() || peer_device_id.len() > 64 {
                write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", r#"{"ok":false,"error":"设备标识无效"}"#.as_bytes()).await;
                return;
            }
            let peer_name = clean_device_name(&req.peer_name, "手机");
            let source_raw = req
                .source_raw
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            // Capture TV's existing source & library snapshot before applying mobile's data.
            let (tv_raw_before, _, _) = active_package_raw_and_version();
            let tv_sync_before = ctx
                .tv_snapshot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();

            let applied = match apply_incoming_sync(
                &ctx.app,
                &ctx.last_imported,
                &ctx.last_sync,
                source_raw.clone(),
                req.sync,
                Some(peer_name.clone()),
                false,
            )
            .await
            {
                Ok(v) => v,
                Err(err) => {
                    let resp = serde_json::json!({ "ok": false, "error": err }).to_string();
                    write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", resp.as_bytes()).await;
                    return;
                }
            };

            let (pair_id, pair_key) = match (random_b64url(12), random_b64url(32)) {
                (Ok(id), Ok(key)) => (id, key),
                _ => {
                    write_response(&mut stream, "500 Internal Server Error", "application/json; charset=utf-8", r#"{"ok":false,"error":"生成配对密钥失败"}"#.as_bytes()).await;
                    return;
                }
            };

            let now = now_secs();
            let store = peer_store_arc();
            if let Err(err) = store.upsert(PairedPeer {
                pair_id: pair_id.clone(),
                pair_key: pair_key.clone(),
                peer_device_id,
                name: peer_name,
                last_ip: peer_ip,
                last_port: 0,
                paired_at: now,
                last_synced_at: now,
            }) {
                let resp = serde_json::json!({ "ok": false, "error": err }).to_string();
                write_response(&mut stream, "500 Internal Server Error", "application/json; charset=utf-8", resp.as_bytes()).await;
                return;
            }
            let _ = ctx.app.emit("hg:tv-peers-changed", ());

            let tv_source_raw = if source_raw.is_none() { tv_raw_before } else { None };
            let resp = serde_json::json!({
                "ok": true,
                "pairId": pair_id,
                "pairKey": pair_key,
                "tvDeviceId": store.device_id(),
                "tvName": ctx.tv_name,
                "source": applied.imported_source,
                "tvSourceRaw": tv_source_raw,
                "tvSync": tv_sync_before,
                "synced": {
                    "favs": applied.favs,
                    "postFavs": applied.post_favs,
                    "history": applied.history,
                    "prefs": applied.prefs,
                    "line": applied.line,
                },
            })
            .to_string();
            write_response(&mut stream, "200 OK", "application/json; charset=utf-8", resp.as_bytes()).await;
        }
        ("POST", "/peer/sync") => {
            let pid = headers.get("x-hg-pair-id").map(String::as_str).unwrap_or("");
            let pkey = headers.get("x-hg-pair-key").map(String::as_str).unwrap_or("");
            let store = peer_store_arc();
            let Some(peer) = store.verify_pair(pid, pkey) else {
                write_response(
                    &mut stream,
                    "401 Unauthorized",
                    "application/json; charset=utf-8",
                    r#"{"ok":false,"error":"电视已取消配对，请重新扫码配对"}"#.as_bytes(),
                )
                .await;
                return;
            };
            let req: TvPeerSyncRequest = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => {
                    write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", r#"{"ok":false,"error":"同步请求格式无效"}"#.as_bytes()).await;
                    return;
                }
            };

            let (tv_raw_before, tv_src_id, tv_src_ver) = active_package_raw_and_version();
            let tv_sync_before = ctx
                .tv_snapshot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();

            let phone_source_raw = req
                .source_raw
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            let applied = match apply_incoming_sync(
                &ctx.app,
                &ctx.last_imported,
                &ctx.last_sync,
                phone_source_raw.clone(),
                req.sync,
                Some(peer.name.clone()),
                true,
            )
            .await
            {
                Ok(v) => v,
                Err(err) => {
                    let resp = serde_json::json!({ "ok": false, "error": err }).to_string();
                    write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", resp.as_bytes()).await;
                    return;
                }
            };

            let _ = store.touch_sync(&peer.pair_id, &peer_ip, 0);
            let _ = ctx.app.emit("hg:tv-peers-changed", ());

            // Return TV's source package if phone doesn't have one or TV holds a newer version of the same source.
            let tv_source_raw = match (tv_raw_before, tv_src_id, tv_src_ver) {
                (Some(raw), Some(tid), Some(tver)) => {
                    let phone_missing = phone_source_raw.is_none()
                        && req.source_id.as_deref().map(str::trim).unwrap_or("").is_empty();
                    let phone_older = req.source_id.as_deref() == Some(tid.as_str())
                        && req.source_version.as_deref().is_some_and(|pv| semver_gt(&tver, pv));
                    if phone_missing || phone_older {
                        Some(raw)
                    } else {
                        None
                    }
                }
                _ => None,
            };

            let source_out = applied.imported_source.or_else(|| {
                store_arc().snapshot().sources.into_iter().find(|s| s.active)
            });

            let resp = serde_json::json!({
                "ok": true,
                "source": source_out,
                "tvSourceRaw": tv_source_raw,
                "tvSync": tv_sync_before,
                "synced": {
                    "favs": applied.favs,
                    "postFavs": applied.post_favs,
                    "history": applied.history,
                    "prefs": applied.prefs,
                    "line": applied.line,
                },
            })
            .to_string();
            write_response(&mut stream, "200 OK", "application/json; charset=utf-8", resp.as_bytes()).await;
        }
        _ => {
            write_response(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"Not Found").await;
        }
    }
}

async fn ensure_server_started(
    app: AppHandle,
    device_name: Option<String>,
) -> Result<(String, u16, String, Arc<Mutex<Option<PairingSession>>>), String> {
    {
        let mut guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(active) = guard.as_mut() {
            let fresh_ip = detect_lan_ipv4();
            if fresh_ip != "127.0.0.1" || active.ip.is_empty() {
                active.ip = fresh_ip;
            }
            if let Some(name) = device_name {
                active.name = clean_device_name(&name, &active.name);
            }
            return Ok((
                active.ip.clone(),
                active.port,
                active.name.clone(),
                Arc::clone(&active.pairing),
            ));
        }
    }

    let listener = match TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], PREFERRED_TCP_PORT))).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
            .await
            .map_err(|e| format!("启动局域网接收服务失败：{e}"))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取监听端口失败：{e}"))?
        .port();
    let ip = detect_lan_ipv4();
    let tv_name = clean_device_name(device_name.as_deref().unwrap_or("HGhubX TV"), "HGhubX TV");

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let pairing: Arc<Mutex<Option<PairingSession>>> = Arc::new(Mutex::new(None));
    let tv_snapshot: Arc<Mutex<TvSyncData>> = Arc::new(Mutex::new(TvSyncData::default()));
    let last_imported: Arc<Mutex<Option<InstalledSourceSummary>>> = Arc::new(Mutex::new(None));
    let last_sync: Arc<Mutex<Option<TvSyncEnvelope>>> = Arc::new(Mutex::new(None));

    let ctx = ClientCtx {
        app,
        tv_name: tv_name.clone(),
        pairing: Arc::clone(&pairing),
        tv_snapshot: Arc::clone(&tv_snapshot),
        last_imported: Arc::clone(&last_imported),
        last_sync: Arc::clone(&last_sync),
    };

    let udp_pairing = Arc::clone(&pairing);
    let udp_name = tv_name.clone();

    tauri::async_runtime::spawn(async move {
        let udp = TokioUdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], DISCOVERY_UDP_PORT)))
            .await
            .ok();
        let mut udp_buf = [0u8; 256];
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, peer_addr)) = accepted else { break; };
                    let c = ctx.clone();
                    tauri::async_runtime::spawn(handle_client(stream, peer_addr, c));
                }
                pkt = async {
                    match udp.as_ref() {
                        Some(sock) => sock.recv_from(&mut udp_buf).await.ok(),
                        None => std::future::pending().await,
                    }
                } => {
                    if let (Some(sock), Some((len, src_addr))) = (udp.as_ref(), pkt) {
                        if let SocketAddr::V4(v4) = src_addr {
                            if is_rfc1918_ipv4(*v4.ip()) && len >= DISCOVERY_MAGIC.len() && udp_buf[..len].starts_with(DISCOVERY_MAGIC) {
                                let pairing_active = {
                                    let guard = udp_pairing.lock().unwrap_or_else(|e| e.into_inner());
                                    guard.as_ref().is_some_and(|p| p.expires_at > Instant::now())
                                };
                                let store = peer_store_arc();
                                let reply = serde_json::json!({
                                    "app": "hghubx-tv",
                                    "v": 1,
                                    "deviceId": store.device_id(),
                                    "name": udp_name,
                                    "port": port,
                                    "pairing": pairing_active,
                                    "pairedIds": store.paired_ids(),
                                })
                                .to_string();
                                let _ = sock.send_to(reply.as_bytes(), src_addr).await;
                            }
                        }
                    }
                }
            }
        }
    });

    let mut guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = guard.as_ref() {
        return Ok((
            active.ip.clone(),
            active.port,
            active.name.clone(),
            Arc::clone(&active.pairing),
        ));
    }
    *guard = Some(TvPeerServer {
        ip: ip.clone(),
        port,
        name: tv_name.clone(),
        pairing: Arc::clone(&pairing),
        tv_snapshot,
        last_imported,
        last_sync,
        _stop_tx: stop_tx,
    });
    Ok((ip, port, tv_name, pairing))
}

#[tauri::command]
pub async fn tv_peer_start(
    app: AppHandle,
    device_name: Option<String>,
) -> Result<LanPushSession, String> {
    let (ip, port, name, pairing) = ensure_server_started(app, device_name).await?;
    let active_pair = {
        let mut guard = pairing.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = guard.as_ref() {
            if p.expires_at > Instant::now() {
                Some((p.token.clone(), p.code.clone()))
            } else {
                *guard = None;
                None
            }
        } else {
            None
        }
    };
    let (token, code) = active_pair.unwrap_or_default();
    let url = if token.is_empty() {
        String::new()
    } else {
        format!("http://{ip}:{port}/?t={token}")
    };
    Ok(LanPushSession {
        url,
        ip,
        port,
        token,
        code,
        device_id: peer_store_arc().device_id(),
        name,
    })
}

#[tauri::command]
pub fn tv_peer_update_snapshot(snapshot: TvSyncData) -> Result<(), String> {
    let clean = sanitize_sync_data(snapshot);
    let guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = guard.as_ref() {
        if let Ok(mut snap) = active.tv_snapshot.lock() {
            *snap = clean;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn source_lan_push_start(app: AppHandle) -> Result<LanPushSession, String> {
    let (ip, port, name, pairing) = ensure_server_started(app, None).await?;
    let existing = {
        let mut guard = pairing.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(active) = guard.as_ref() {
            if active.expires_at > Instant::now() + Duration::from_secs(30) {
                Some((active.token.clone(), active.code.clone()))
            } else {
                *guard = None;
                None
            }
        } else {
            None
        }
    };
    let (token, code) = match existing {
        Some(pair) => pair,
        None => {
            let tok = random_b64url(6)?;
            let pin = generate_code()?;
            let mut guard = pairing.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(PairingSession {
                token: tok.clone(),
                code: pin.clone(),
                failed_attempts: 0,
                expires_at: Instant::now() + PAIRING_TTL,
            });
            (tok, pin)
        }
    };
    let url = format!("http://{ip}:{port}/?t={token}");
    Ok(LanPushSession {
        url,
        ip,
        port,
        token,
        code,
        device_id: peer_store_arc().device_id(),
        name,
    })
}

#[tauri::command]
pub fn source_lan_push_stop() -> Result<(), String> {
    // Only stop temporary QR/PIN pairing mode; keep TCP+UDP peer service alive for paired devices.
    let guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = guard.as_ref() {
        if let Ok(mut p) = active.pairing.lock() {
            *p = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn source_lan_push_status() -> Result<LanPushStatus, String> {
    let guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = guard.as_ref() {
        let pairing_session = {
            let mut p = active.pairing.lock().unwrap_or_else(|e| e.into_inner());
            if p.as_ref().is_some_and(|s| s.expires_at <= Instant::now()) {
                *p = None;
            }
            p.clone()
        };
        let last = active
            .last_imported
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let sync = active
            .last_sync
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let url = pairing_session
            .as_ref()
            .map(|s| format!("http://{}:{}/?t={}", active.ip, active.port, s.token));
        let code = pairing_session.as_ref().map(|s| s.code.clone());
        Ok(LanPushStatus {
            active: true,
            pairing: pairing_session.is_some(),
            url,
            code,
            last_imported: last,
            last_sync: sync,
        })
    } else {
        Ok(LanPushStatus {
            active: false,
            pairing: false,
            url: None,
            code: None,
            last_imported: None,
            last_sync: None,
        })
    }
}

#[tauri::command]
pub async fn tv_peer_discover() -> Result<Vec<DiscoveredTv>, String> {
    let sock = TokioUdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
        .await
        .map_err(|e| format!("无法发起局域网发现：{e}"))?;
    let _ = sock.set_broadcast(true);

    let mut targets: Vec<SocketAddr> = vec![SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_UDP_PORT))];
    if let Ok(lan_ip) = detect_lan_ipv4().parse::<Ipv4Addr>() {
        if is_rfc1918_ipv4(lan_ip) {
            let [a, b, c, _] = lan_ip.octets();
            targets.push(SocketAddr::from((Ipv4Addr::new(a, b, c, 255), DISCOVERY_UDP_PORT)));
        }
    }

    for target in &targets {
        let _ = sock.send_to(DISCOVERY_MAGIC, target).await;
    }

    let local_peers = peer_store_arc().list_summaries();
    let local_device_id = peer_store_arc().device_id();
    let mut found: HashMap<String, DiscoveredTv> = HashMap::new();
    let mut buf = [0u8; 1024];
    let second_pulse = tokio::time::sleep(Duration::from_millis(240));
    tokio::pin!(second_pulse);
    let mut pulsed = false;
    let deadline = tokio::time::sleep(Duration::from_millis(820));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => break,
            _ = &mut second_pulse, if !pulsed => {
                pulsed = true;
                for target in &targets {
                    let _ = sock.send_to(DISCOVERY_MAGIC, target).await;
                }
            }
            res = sock.recv_from(&mut buf) => {
                let Ok((len, src)) = res else { break; };
                let SocketAddr::V4(v4) = src else { continue; };
                if !is_rfc1918_ipv4(*v4.ip()) {
                    continue;
                }
                let Ok(v) = serde_json::from_slice::<Value>(&buf[..len]) else { continue; };
                if v.get("app").and_then(Value::as_str) != Some("hghubx-tv") {
                    continue;
                }
                let device_id = v.get("deviceId").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if device_id.is_empty() || device_id.len() > 64 || device_id == local_device_id {
                    continue;
                }
                let Some(port) = v.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p >= 1024) else {
                    continue;
                };
                let name = clean_device_name(v.get("name").and_then(Value::as_str).unwrap_or("HGhubX TV"), "HGhubX TV");
                let pairing = v.get("pairing").and_then(Value::as_bool).unwrap_or(false);
                let tv_paired_ids: HashSet<String> = v
                    .get("pairedIds")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let matched = local_peers
                    .iter()
                    .find(|p| p.peer_device_id == device_id || tv_paired_ids.contains(&p.pair_id));
                found.insert(device_id.clone(), DiscoveredTv {
                    device_id,
                    name,
                    ip: v4.ip().to_string(),
                    port,
                    pairing,
                    pair_id: matched.map(|m| m.pair_id.clone()),
                    last_synced_at: matched.map(|m| m.last_synced_at),
                });
            }
        }
    }

    let mut list: Vec<DiscoveredTv> = found.into_values().collect();
    list.sort_by(|a, b| {
        b.pair_id
            .is_some()
            .cmp(&a.pair_id.is_some())
            .then(b.last_synced_at.unwrap_or(0).cmp(&a.last_synced_at.unwrap_or(0)))
            .then(a.name.cmp(&b.name))
    });
    Ok(list)
}

#[tauri::command]
pub fn tv_peer_list() -> Vec<PairedPeerSummary> {
    peer_store_arc().list_summaries()
}

#[tauri::command]
pub fn tv_peer_remove(pair_id: String) -> Result<Vec<PairedPeerSummary>, String> {
    peer_store_arc().remove(&pair_id)
}

fn validate_lan_push_target(raw: &str) -> Result<(Ipv4Addr, u16, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err("电视端地址无效".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "电视端地址格式无效".to_string())?;
    if parsed.scheme() != "http" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("仅支持电视端局域网 HTTP 推送地址".into());
    }
    let ip = match parsed.host() {
        Some(url::Host::Ipv4(addr)) if is_rfc1918_ipv4(addr) => addr,
        _ => return Err("仅支持局域网私有 IPv4 地址（10.x / 172.16-31.x / 192.168.x）".into()),
    };
    let port = parsed
        .port()
        .filter(|p| *p >= 1024)
        .ok_or_else(|| "电视端端口无效（需 >= 1024）".to_string())?;
    let token = parsed
        .query_pairs()
        .find(|(k, _)| k == "t")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    if !(4..=64).contains(&token.len())
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("缺少有效的电视端配对令牌".into());
    }
    Ok((ip, port, token))
}

async fn post_lan_http(
    ip: Ipv4Addr,
    port: u16,
    path_and_query: &str,
    content_type: &str,
    extra_headers: &[(&str, &str)],
    body: &[u8],
) -> Result<(u16, String), String> {
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let mut stream = tokio::time::timeout(Duration::from_secs(6), TcpStream::connect(addr))
        .await
        .map_err(|_| "连接电视超时，请确认手机与电视处于同一局域网".to_string())?
        .map_err(|e| format!("无法连接电视（{ip}:{port}）：{e}"))?;
    let mut head = format!(
        "POST {path_and_query} HTTP/1.1\r\nHost: {ip}:{port}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");

    let resp = tokio::time::timeout(Duration::from_secs(20), async {
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| format!("发送请求失败：{e}"))?;
        stream
            .write_all(body)
            .await
            .map_err(|e| format!("发送同步数据失败：{e}"))?;
        stream
            .flush()
            .await
            .map_err(|e| format!("发送数据失败：{e}"))?;
        let mut buf = Vec::with_capacity(4096);
        let mut tmp = [0u8; 4096];
        loop {
            let n = stream
                .read(&mut tmp)
                .await
                .map_err(|e| format!("读取电视响应失败：{e}"))?;
            if n == 0 {
                break;
            }
            if buf.len() + n > MAX_CLIENT_RESP_BYTES {
                return Err("电视端响应过大".to_string());
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        Ok::<Vec<u8>, String>(buf)
    })
    .await
    .map_err(|_| "等待电视响应超时".to_string())??;

    let Some(split) = resp.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Err("电视端返回了无效响应".into());
    };
    let status_line = std::str::from_utf8(&resp[..split])
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "电视端状态码无效".to_string())?;
    let resp_body = String::from_utf8_lossy(&resp[(split + 4)..]).to_string();
    Ok((status, resp_body))
}

fn parse_bidirectional_sync_fields(parsed: &Value) -> (Option<String>, Option<String>, usize, usize, usize, TvSyncData) {
    let source_name = parsed
        .get("source")
        .and_then(|s| s.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let source_version = parsed
        .get("source")
        .and_then(|s| s.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let synced = parsed.get("synced");
    let pushed_favs = synced.and_then(|v| v.get("favs")).and_then(Value::as_u64).unwrap_or(0) as usize;
    let pushed_post_favs = synced.and_then(|v| v.get("postFavs")).and_then(Value::as_u64).unwrap_or(0) as usize;
    let pushed_history = synced.and_then(|v| v.get("history")).and_then(Value::as_u64).unwrap_or(0) as usize;
    let tv_sync = parsed
        .get("tvSync")
        .cloned()
        .and_then(|v| serde_json::from_value::<TvSyncData>(v).ok())
        .map(sanitize_sync_data)
        .unwrap_or_default();
    (source_name, source_version, pushed_favs, pushed_post_favs, pushed_history, tv_sync)
}

async fn perform_pair(
    ip: Ipv4Addr,
    port: u16,
    pair_path: &str,
    legacy_token: Option<&str>,
    phone_name: String,
    include_source: bool,
    sync: Option<TvSyncData>,
) -> Result<TvBidirectionalSyncResult, String> {
    let source_raw = if include_source {
        store_arc()
            .active_package()
            .and_then(|pkg| serde_json::to_string(&pkg).ok())
    } else {
        None
    };

    let clean_name = clean_device_name(&phone_name, "手机");
    let store = peer_store_arc();
    let req = TvPairRequest {
        peer_device_id: store.device_id(),
        peer_name: clean_name,
        source_raw: source_raw.clone(),
        sync: sync.clone(),
    };
    let payload = serde_json::to_vec(&req).map_err(|e| format!("序列化配对数据失败：{e}"))?;
    if payload.len() > MAX_SYNC_BODY_BYTES {
        return Err("同步数据超过 1 MB 上限".into());
    }

    let (status, body) = post_lan_http(ip, port, pair_path, "application/json; charset=utf-8", &[], &payload).await?;

    // Compatibility fallback for older TV builds that only implemented `/sync` or `/push`
    if status == 404 {
        if let Some(tok) = legacy_token {
            let sync_req = TvSyncRequest {
                source_raw: source_raw.clone(),
                sync,
                peer_name: None,
            };
            let sync_payload = serde_json::to_vec(&sync_req).map_err(|e| format!("序列化同步数据失败：{e}"))?;
            let (st2, body2) = post_lan_http(ip, port, &format!("/sync?t={tok}"), "application/json; charset=utf-8", &[], &sync_payload).await?;
            if st2 == 404 {
                if let Some(raw) = source_raw {
                    let (st3, body3) = post_lan_http(ip, port, &format!("/push?t={tok}"), "text/plain;charset=utf-8", &[], raw.as_bytes()).await?;
                    let parsed3: Value = serde_json::from_str(&body3).unwrap_or(Value::Null);
                    if st3 < 400 && parsed3.get("ok").and_then(Value::as_bool) == Some(true) {
                        return Ok(TvBidirectionalSyncResult {
                            ok: true,
                            pair_id: None,
                            tv_name: "HGhubX TV".into(),
                            tv_ip: ip.to_string(),
                            source_name: parsed3.get("name").and_then(Value::as_str).map(str::to_string),
                            source_version: parsed3.get("version").and_then(Value::as_str).map(str::to_string),
                            pushed_favs: 0,
                            pushed_post_favs: 0,
                            pushed_history: 0,
                            tv_sync: TvSyncData::default(),
                            imported_source_from_tv: None,
                            legacy_source_only: true,
                        });
                    }
                    let err_msg = parsed3.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("电视端导入失败（HTTP {st3}）"));
                    return Err(err_msg);
                }
                return Err("电视端版本过旧，请更新 TV 版".into());
            }
            let parsed2: Value = serde_json::from_str(&body2).unwrap_or(Value::Null);
            if st2 < 400 && parsed2.get("ok").and_then(Value::as_bool) == Some(true) {
                let (sn, sv, pf, ppf, ph, tvs) = parse_bidirectional_sync_fields(&parsed2);
                return Ok(TvBidirectionalSyncResult {
                    ok: true,
                    pair_id: None,
                    tv_name: "HGhubX TV".into(),
                    tv_ip: ip.to_string(),
                    source_name: sn,
                    source_version: sv,
                    pushed_favs: pf,
                    pushed_post_favs: ppf,
                    pushed_history: ph,
                    tv_sync: tvs,
                    imported_source_from_tv: None,
                    legacy_source_only: false,
                });
            }
            let err_msg = parsed2.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("电视端拒绝接收（HTTP {st2}）"));
            return Err(err_msg);
        }
        return Err("电视端版本过旧，请更新 TV 版后使用配对码".into());
    }

    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if status >= 400 || parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let err_msg = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("电视端拒绝配对（HTTP {status}）"));
        return Err(err_msg);
    }

    let pair_id = parsed.get("pairId").and_then(Value::as_str).unwrap_or("").to_string();
    let pair_key = parsed.get("pairKey").and_then(Value::as_str).unwrap_or("").to_string();
    let tv_device_id = parsed.get("tvDeviceId").and_then(Value::as_str).unwrap_or("").to_string();
    let tv_name = clean_device_name(parsed.get("tvName").and_then(Value::as_str).unwrap_or("HGhubX TV"), "HGhubX TV");

    if !pair_id.is_empty() && !pair_key.is_empty() && !tv_device_id.is_empty() {
        let now = now_secs();
        let _ = store.upsert(PairedPeer {
            pair_id: pair_id.clone(),
            pair_key,
            peer_device_id: tv_device_id,
            name: tv_name.clone(),
            last_ip: ip.to_string(),
            last_port: port,
            paired_at: now,
            last_synced_at: now,
        });
    }

    let imported_source_from_tv = match parsed.get("tvSourceRaw").and_then(Value::as_str) {
        Some(raw) if !raw.trim().is_empty() => import_source_raw(raw, true).await.ok(),
        _ => None,
    };

    let (sn, sv, pf, ppf, ph, tvs) = parse_bidirectional_sync_fields(&parsed);
    Ok(TvBidirectionalSyncResult {
        ok: true,
        pair_id: (!pair_id.is_empty()).then_some(pair_id),
        tv_name,
        tv_ip: ip.to_string(),
        source_name: sn,
        source_version: sv,
        pushed_favs: pf,
        pushed_post_favs: ppf,
        pushed_history: ph,
        tv_sync: tvs,
        imported_source_from_tv,
        legacy_source_only: false,
    })
}

#[tauri::command]
pub async fn tv_peer_pair_qr(
    target_url: String,
    phone_name: String,
    include_source: bool,
    sync: Option<TvSyncData>,
) -> Result<TvBidirectionalSyncResult, String> {
    let (ip, port, token) = validate_lan_push_target(&target_url)?;
    perform_pair(
        ip,
        port,
        &format!("/pair?t={token}"),
        Some(&token),
        phone_name,
        include_source,
        sync,
    )
    .await
}

#[tauri::command]
pub async fn tv_peer_pair_code(
    ip: String,
    port: u16,
    code: String,
    phone_name: String,
    include_source: bool,
    sync: Option<TvSyncData>,
) -> Result<TvBidirectionalSyncResult, String> {
    let ipv4: Ipv4Addr = ip
        .trim()
        .parse()
        .map_err(|_| "电视 IP 地址无效".to_string())?;
    if !is_rfc1918_ipv4(ipv4) {
        return Err("仅支持局域网私有 IPv4 地址".into());
    }
    if port < 1024 {
        return Err("电视端口无效".into());
    }
    let clean_code = code.trim();
    if clean_code.len() != 4 || !clean_code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("请输入 4 位数字配对码".into());
    }
    perform_pair(
        ipv4,
        port,
        &format!("/pair?code={clean_code}"),
        None,
        phone_name,
        include_source,
        sync,
    )
    .await
}

#[tauri::command]
pub async fn tv_peer_sync(
    pair_id: String,
    ip_override: Option<String>,
    port_override: Option<u16>,
    include_source: bool,
    sync: Option<TvSyncData>,
) -> Result<TvBidirectionalSyncResult, String> {
    let store = peer_store_arc();
    let peer = store
        .get_by_pair_id(&pair_id)
        .ok_or_else(|| "未找到该已配对的电视，请重新扫码配对".to_string())?;

    let target_ip_str = ip_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&peer.last_ip);
    let ipv4: Ipv4Addr = target_ip_str
        .parse()
        .map_err(|_| "电视 IP 地址无效，请确保电视处于开机状态".to_string())?;
    if !is_rfc1918_ipv4(ipv4) {
        return Err("仅支持局域网私有 IPv4 地址".into());
    }
    let port = port_override.filter(|p| *p >= 1024).unwrap_or(peer.last_port);
    if port < 1024 {
        return Err("电视端口无效，请在同网络重试发现电视".into());
    }

    let (source_raw, source_id, source_version) = if include_source {
        active_package_raw_and_version()
    } else {
        (None, None, None)
    };

    let req = TvPeerSyncRequest {
        source_raw,
        source_id,
        source_version,
        sync,
    };
    let payload = serde_json::to_vec(&req).map_err(|e| format!("序列化同步数据失败：{e}"))?;
    if payload.len() > MAX_SYNC_BODY_BYTES {
        return Err("同步数据超过 1 MB 上限".into());
    }

    let (status, body) = post_lan_http(
        ipv4,
        port,
        "/peer/sync",
        "application/json; charset=utf-8",
        &[("X-HG-Pair-Id", &peer.pair_id), ("X-HG-Pair-Key", &peer.pair_key)],
        &payload,
    )
    .await?;

    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if status == 401 {
        let _ = store.remove(&peer.pair_id);
        return Err(parsed
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "电视已取消配对，请重新扫码配对".to_string()));
    }
    if status >= 400 || parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let err_msg = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("同步失败（HTTP {status}）"));
        return Err(err_msg);
    }

    let _ = store.touch_sync(&peer.pair_id, &ipv4.to_string(), port);
    let imported_source_from_tv = match parsed.get("tvSourceRaw").and_then(Value::as_str) {
        Some(raw) if !raw.trim().is_empty() => import_source_raw(raw, true).await.ok(),
        _ => None,
    };

    let (sn, sv, pf, ppf, ph, tvs) = parse_bidirectional_sync_fields(&parsed);
    Ok(TvBidirectionalSyncResult {
        ok: true,
        pair_id: Some(peer.pair_id),
        tv_name: peer.name,
        tv_ip: ipv4.to_string(),
        source_name: sn,
        source_version: sv,
        pushed_favs: pf,
        pushed_post_favs: ppf,
        pushed_history: ph,
        tv_sync: tvs,
        imported_source_from_tv,
        legacy_source_only: false,
    })
}

#[tauri::command]
pub async fn source_lan_push_to_tv(
    target_url: String,
    include_source: bool,
    sync: Option<TvSyncData>,
) -> Result<LanPushClientResult, String> {
    let res = tv_peer_pair_qr(target_url, "HGhubX".into(), include_source, sync).await?;
    Ok(LanPushClientResult {
        ok: res.ok,
        source_name: res.source_name,
        source_version: res.source_version,
        synced_favs: res.pushed_favs,
        synced_post_favs: res.pushed_post_favs,
        synced_history: res.pushed_history,
        legacy_source_only: res.legacy_source_only,
    })
}
