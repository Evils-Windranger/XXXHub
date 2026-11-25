//! Ephemeral LAN HTTP server and client for TV QR-code source push & data sync.
//!
//! Security boundary:
//! - Server started only on explicit user/UI action and stopped immediately on exit or idle timeout.
//! - Requires a per-session random token on every route (`GET /?t=...`, `POST /push?t=...`, `POST /sync?t=...`).
//! - Bounded headers (8 KB) and body (512 KB for `/push`, 1 MB for `/sync`); never proxies external URLs.
//! - Outgoing client (`source_lan_push_to_tv`) connects directly via TCP only to literal RFC1918 IPv4 + explicit port >= 1024.

use super::commands::import_source_raw;
use super::manifest::MAX_PACKAGE_JSON_BYTES;
use super::store::InstalledSourceSummary;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine;
use once_cell::sync::Lazy;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_SYNC_BODY_BYTES: usize = 1024 * 1024;
const MAX_CLIENT_RESP_BYTES: usize = 64 * 1024;
const MAX_SYNC_ITEMS: usize = 5000;
const MAX_BLOCKED_TAGS: usize = 200;
const MAX_PINNED_TAGS: usize = 24;
const MAX_TAG_CHARS: usize = 64;
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const CONN_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPushSession {
    pub url: String,
    pub ip: String,
    pub port: u16,
    pub token: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TvSyncRequest {
    pub source_raw: Option<String>,
    pub sync: Option<TvSyncData>,
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
    pub url: Option<String>,
    pub last_imported: Option<InstalledSourceSummary>,
    pub last_sync: Option<TvSyncEnvelope>,
}

struct ActiveServer {
    session: LanPushSession,
    stop_tx: Option<oneshot::Sender<()>>,
    last_imported: Arc<Mutex<Option<InstalledSourceSummary>>>,
    last_sync: Arc<Mutex<Option<TvSyncEnvelope>>>,
    started_at: Instant,
}

static SERVER: Lazy<Mutex<Option<ActiveServer>>> = Lazy::new(|| Mutex::new(None));
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

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 6];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "生成临时令牌失败".to_string())?;
    Ok(B64_URL.encode(bytes))
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
  <textarea id="t" placeholder="链接 / npm:包名 / JSON" autofocus></textarea>
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

fn query_token(target: &str) -> Option<String> {
    let (_, query) = target.split_once('?')?;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == "t")
        .map(|(_, v)| v.into_owned())
}

async fn read_http_request(stream: &mut TcpStream) -> Result<(String, String, Vec<u8>), &'static str> {
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
    let is_sync = path == "/sync";
    let max_body = if is_sync {
        MAX_SYNC_BODY_BYTES
    } else {
        MAX_PACKAGE_JSON_BYTES
    };
    let too_large_err = if is_sync {
        "body_too_large_sync"
    } else {
        "body_too_large"
    };

    let mut content_length: usize = 0;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse::<usize>().map_err(|_| "bad_len")?;
                if content_length > max_body {
                    return Err(too_large_err);
                }
            }
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
    Ok((method, target, body))
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

async fn handle_client(
    mut stream: TcpStream,
    expected_token: String,
    app: AppHandle,
    last_imported: Arc<Mutex<Option<InstalledSourceSummary>>>,
    last_sync: Arc<Mutex<Option<TvSyncEnvelope>>>,
) {
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

    let (method, target, body) = parsed;
    let path = target.split('?').next().unwrap_or("");
    let tok_ok = query_token(&target).is_some_and(|t| t == expected_token);
    if !tok_ok {
        write_response(&mut stream, "403 Forbidden", "text/plain; charset=utf-8", b"Forbidden").await;
        return;
    }

    match (method.as_str(), path) {
        ("GET", "/") => {
            let html = push_page_html(&expected_token);
            write_response(&mut stream, "200 OK", "text/html; charset=utf-8", html.as_bytes()).await;
        }
        ("POST", "/push") => {
            let raw = String::from_utf8_lossy(&body).trim().to_string();
            if raw.is_empty() {
                write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", r#"{"ok":false,"error":"内容为空"}"#.as_bytes()).await;
                return;
            }
            match import_source_raw(&raw, true).await {
                Ok(summary) => {
                    if let Ok(mut guard) = last_imported.lock() {
                        *guard = Some(summary.clone());
                    }
                    let _ = app.emit("hg:source-pushed", &summary);
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

            let mut imported_summary: Option<InstalledSourceSummary> = None;
            if let Some(raw) = source_raw {
                match import_source_raw(&raw, true).await {
                    Ok(summary) => {
                        if let Ok(mut guard) = last_imported.lock() {
                            *guard = Some(summary.clone());
                        }
                        imported_summary = Some(summary);
                    }
                    Err(err) => {
                        let resp = serde_json::json!({ "ok": false, "error": err }).to_string();
                        write_response(&mut stream, "400 Bad Request", "application/json; charset=utf-8", resp.as_bytes()).await;
                        return;
                    }
                }
            }

            let clean_sync = req.sync.map(sanitize_sync_data).unwrap_or_default();
            let mut line_applied = false;
            if let Some(ref url) = clean_sync.line_base {
                if crate::net::set_base(url).is_ok() {
                    crate::net::refresh_client();
                    line_applied = true;
                }
            }

            let fav_count = clean_sync.favs.len();
            let post_fav_count = clean_sync.post_favs.len();
            let hist_count = clean_sync.history.len();
            let prefs_synced = clean_sync.content_preferences.is_some()
                || clean_sync.prefer_hevc.is_some()
                || clean_sync.auto_line.is_some();

            let envelope = TvSyncEnvelope {
                sync_id: NEXT_SYNC_ID.fetch_add(1, Ordering::Relaxed),
                source: imported_summary.clone(),
                sync: clean_sync,
            };
            if let Ok(mut guard) = last_sync.lock() {
                *guard = Some(envelope.clone());
            }
            let _ = app.emit("hg:tv-sync-pushed", &envelope);
            if let Some(ref summary) = imported_summary {
                let _ = app.emit("hg:source-pushed", summary);
            }

            let resp = serde_json::json!({
                "ok": true,
                "source": imported_summary,
                "synced": {
                    "favs": fav_count,
                    "postFavs": post_fav_count,
                    "history": hist_count,
                    "prefs": prefs_synced,
                    "line": line_applied,
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

#[tauri::command]
pub async fn source_lan_push_start(app: AppHandle) -> Result<LanPushSession, String> {
    {
        let guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(active) = guard.as_ref() {
            if active.started_at.elapsed() < IDLE_TIMEOUT - Duration::from_secs(30) {
                return Ok(active.session.clone());
            }
        }
    }
    let _ = source_lan_push_stop();

    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
        .await
        .map_err(|e| format!("启动局域网接收服务失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取监听端口失败：{e}"))?
        .port();
    let ip = detect_lan_ipv4();
    let token = generate_token()?;
    let url = format!("http://{ip}:{port}/?t={token}");
    let session = LanPushSession {
        url,
        ip,
        port,
        token: token.clone(),
    };

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let last_imported: Arc<Mutex<Option<InstalledSourceSummary>>> = Arc::new(Mutex::new(None));
    let last_sync: Arc<Mutex<Option<TvSyncEnvelope>>> = Arc::new(Mutex::new(None));
    let last_clone = Arc::clone(&last_imported);
    let sync_clone = Arc::clone(&last_sync);
    let tok_clone = token.clone();

    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::sleep(IDLE_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = &mut deadline => break,
                accepted = listener.accept() => {
                    let Ok((stream, _peer)) = accepted else { break; };
                    let tok = tok_clone.clone();
                    let app_clone = app.clone();
                    let last = Arc::clone(&last_clone);
                    let sync_state = Arc::clone(&sync_clone);
                    tauri::async_runtime::spawn(handle_client(stream, tok, app_clone, last, sync_state));
                }
            }
        }
        let mut guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().is_some_and(|s| s.session.token == tok_clone) {
            *guard = None;
        }
    });

    let mut guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(ActiveServer {
        session: session.clone(),
        stop_tx: Some(stop_tx),
        last_imported,
        last_sync,
        started_at: Instant::now(),
    });
    Ok(session)
}

#[tauri::command]
pub fn source_lan_push_stop() -> Result<(), String> {
    let mut guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut active) = guard.take() {
        if let Some(tx) = active.stop_tx.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn source_lan_push_status() -> Result<LanPushStatus, String> {
    let guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(active) = guard.as_ref() {
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
        Ok(LanPushStatus {
            active: true,
            url: Some(active.session.url.clone()),
            last_imported: last,
            last_sync: sync,
        })
    } else {
        Ok(LanPushStatus {
            active: false,
            url: None,
            last_imported: None,
            last_sync: None,
        })
    }
}

fn is_rfc1918_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
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
    body: &[u8],
) -> Result<(u16, String), String> {
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let mut stream = tokio::time::timeout(Duration::from_secs(8), TcpStream::connect(addr))
        .await
        .map_err(|_| "连接电视超时，请确认手机与电视处于同一局域网".to_string())?
        .map_err(|e| format!("无法连接电视（{ip}:{port}）：{e}"))?;
    let head = format!(
        "POST {path_and_query} HTTP/1.1\r\nHost: {ip}:{port}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
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
        let mut tmp = [0u8; 2048];
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

#[tauri::command]
pub async fn source_lan_push_to_tv(
    target_url: String,
    include_source: bool,
    sync: Option<TvSyncData>,
) -> Result<LanPushClientResult, String> {
    let (ip, port, token) = validate_lan_push_target(&target_url)?;
    let source_raw = if include_source {
        let pkg = super::store_arc()
            .active_package()
            .ok_or_else(|| "当前未启用视频源，请先导入或取消勾选视频源".to_string())?;
        Some(serde_json::to_string(&pkg).map_err(|e| format!("序列化视频源失败：{e}"))?)
    } else {
        None
    };

    if source_raw.is_none() && sync.is_none() {
        return Err("请至少选择一项要同步的内容".into());
    }

    let req = TvSyncRequest {
        source_raw: source_raw.clone(),
        sync,
    };
    let payload = serde_json::to_vec(&req).map_err(|e| format!("序列化同步数据失败：{e}"))?;
    if payload.len() > MAX_SYNC_BODY_BYTES {
        return Err("同步数据超过 1 MB 上限".into());
    }

    let sync_path = format!("/sync?t={token}");
    let (status, body) = post_lan_http(ip, port, &sync_path, "application/json; charset=utf-8", &payload).await?;

    if status == 404 {
        if let Some(raw) = source_raw {
            let push_path = format!("/push?t={token}");
            let (st2, body2) = post_lan_http(
                ip,
                port,
                &push_path,
                "text/plain;charset=utf-8",
                raw.as_bytes(),
            )
            .await?;
            let parsed2: Value = serde_json::from_str(&body2).unwrap_or(Value::Null);
            if st2 < 400 && parsed2.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(LanPushClientResult {
                    ok: true,
                    source_name: parsed2.get("name").and_then(Value::as_str).map(str::to_string),
                    source_version: parsed2.get("version").and_then(Value::as_str).map(str::to_string),
                    synced_favs: 0,
                    synced_post_favs: 0,
                    synced_history: 0,
                    legacy_source_only: true,
                });
            }
            let err_msg = parsed2
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("电视端导入失败（HTTP {st2}）"));
            return Err(err_msg);
        }
        return Err("电视端版本过旧，暂不支持仅同步数据，请先更新 TV 版".into());
    }

    let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if status >= 400 || parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let err_msg = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("电视端拒绝接收（HTTP {status}）"));
        return Err(err_msg);
    }

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
    let synced_favs = synced
        .and_then(|v| v.get("favs"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let synced_post_favs = synced
        .and_then(|v| v.get("postFavs"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let synced_history = synced
        .and_then(|v| v.get("history"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;

    Ok(LanPushClientResult {
        ok: true,
        source_name,
        source_version,
        synced_favs,
        synced_post_favs,
        synced_history,
        legacy_source_only: false,
    })
}
