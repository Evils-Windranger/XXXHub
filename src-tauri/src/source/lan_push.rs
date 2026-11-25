//! Ephemeral LAN HTTP server for TV QR-code source push.
//!
//! Security boundary:
//! - Started only on explicit user/UI action and stopped immediately on exit or idle timeout.
//! - Requires a per-session random token on every route (`GET /?t=...`, `POST /push?t=...`).
//! - Bounded headers (8 KB) and body (512 KB); never proxies or forwards external URLs.

use super::commands::import_source_raw;
use super::manifest::MAX_PACKAGE_JSON_BYTES;
use super::store::InstalledSourceSummary;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine;
use once_cell::sync::Lazy;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const MAX_HEADER_BYTES: usize = 8 * 1024;
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPushStatus {
    pub active: bool,
    pub url: Option<String>,
    pub last_imported: Option<InstalledSourceSummary>,
}

struct ActiveServer {
    session: LanPushSession,
    stop_tx: Option<oneshot::Sender<()>>,
    last_imported: Arc<Mutex<Option<InstalledSourceSummary>>>,
    started_at: Instant,
}

static SERVER: Lazy<Mutex<Option<ActiveServer>>> = Lazy::new(|| Mutex::new(None));

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

    let mut content_length: usize = 0;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse::<usize>().map_err(|_| "bad_len")?;
                if content_length > MAX_PACKAGE_JSON_BYTES {
                    return Err("body_too_large");
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
        if body.len() > MAX_PACKAGE_JSON_BYTES {
            return Err("body_too_large");
        }
    }
    body.truncate(content_length);
    Ok((method, target, body))
}

async fn handle_client(
    mut stream: TcpStream,
    expected_token: String,
    app: AppHandle,
    last_imported: Arc<Mutex<Option<InstalledSourceSummary>>>,
) {
    let parsed = match tokio::time::timeout(CONN_TIMEOUT, read_http_request(&mut stream)).await {
        Ok(Ok(req)) => req,
        Ok(Err("body_too_large")) => {
            write_response(&mut stream, "413 Payload Too Large", "application/json; charset=utf-8", r#"{"ok":false,"error":"内容超过 512 KB"}"#.as_bytes()).await;
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
    let last_clone = Arc::clone(&last_imported);
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
                    tauri::async_runtime::spawn(handle_client(stream, tok, app_clone, last));
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
        Ok(LanPushStatus {
            active: true,
            url: Some(active.session.url.clone()),
            last_imported: last,
        })
    } else {
        Ok(LanPushStatus {
            active: false,
            url: None,
            last_imported: None,
        })
    }
}
