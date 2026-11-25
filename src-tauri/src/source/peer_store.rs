//! Persistent paired-device store (`<app_data_dir>/lan_peers.json`) for TV ↔ phone LAN sync.
//!
//! Security boundary:
//! - Secret `pair_key` is kept strictly inside Rust and never returned to WebViews, UDP discovery, or logs.
//! - Verification uses constant-time byte comparison (`ring::constant_time`).

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PEERS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPeer {
    pub pair_id: String,
    pub pair_key: String,
    pub peer_device_id: String,
    pub name: String,
    pub last_ip: String,
    pub last_port: u16,
    pub paired_at: u64,
    pub last_synced_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPeerSummary {
    pub pair_id: String,
    pub peer_device_id: String,
    pub name: String,
    pub last_ip: String,
    pub last_port: u16,
    pub paired_at: u64,
    pub last_synced_at: u64,
}

impl From<&PairedPeer> for PairedPeerSummary {
    fn from(p: &PairedPeer) -> Self {
        Self {
            pair_id: p.pair_id.clone(),
            peer_device_id: p.peer_device_id.clone(),
            name: p.name.clone(),
            last_ip: p.last_ip.clone(),
            last_port: p.last_port,
            paired_at: p.paired_at,
            last_synced_at: p.last_synced_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeersFile {
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    peers: Vec<PairedPeer>,
}

struct PeerState {
    path: Option<PathBuf>,
    device_id: String,
    peers: Vec<PairedPeer>,
}

pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn random_b64url(num_bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; num_bytes];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| "生成随机密钥失败".to_string())?;
    Ok(B64_URL.encode(&buf))
}

fn fallback_device_id() -> String {
    random_b64url(12).unwrap_or_else(|_| format!("hg-{}", now_secs()))
}

fn save_file(path: &Path, device_id: &str, peers: &[PairedPeer]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(&PeersFile {
        device_id: device_id.to_string(),
        peers: peers.to_vec(),
    })
    .map_err(|e| format!("序列化配对设备失败：{e}"))?;
    fs::write(&tmp, body).map_err(|e| format!("保存配对设备失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("保存配对设备失败：{e}"))?;
    Ok(())
}

pub struct PeerStore {
    inner: RwLock<PeerState>,
}

pub(crate) fn const_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

impl PeerStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(PeerState {
                path: None,
                device_id: fallback_device_id(),
                peers: Vec::new(),
            }),
        }
    }

    pub fn bind(&self, app_data_dir: &Path) {
        let path = app_data_dir.join("lan_peers.json");
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.path = Some(path.clone());
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(parsed) = serde_json::from_slice::<PeersFile>(&bytes) {
                if !parsed.device_id.trim().is_empty() {
                    guard.device_id = parsed.device_id;
                }
                guard.peers = parsed.peers.into_iter().take(MAX_PEERS).collect();
                return;
            }
        }
        let _ = save_file(&path, &guard.device_id, &guard.peers);
    }

    pub fn device_id(&self) -> String {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .device_id
            .clone()
    }

    pub fn list_summaries(&self) -> Vec<PairedPeerSummary> {
        let guard = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<PairedPeerSummary> = guard.peers.iter().map(PairedPeerSummary::from).collect();
        out.sort_by(|a, b| b.last_synced_at.cmp(&a.last_synced_at).then(b.paired_at.cmp(&a.paired_at)));
        out
    }

    pub fn paired_ids(&self) -> Vec<String> {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .peers
            .iter()
            .map(|p| p.pair_id.clone())
            .collect()
    }

    pub fn get_by_pair_id(&self, pair_id: &str) -> Option<PairedPeer> {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .peers
            .iter()
            .find(|p| p.pair_id == pair_id)
            .cloned()
    }

    pub fn verify_pair(&self, pair_id: &str, pair_key: &str) -> Option<PairedPeer> {
        if pair_id.is_empty() || pair_key.is_empty() {
            return None;
        }
        let guard = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let peer = guard.peers.iter().find(|p| p.pair_id == pair_id)?;
        if const_time_eq(peer.pair_key.as_bytes(), pair_key.as_bytes()) {
            Some(peer.clone())
        } else {
            None
        }
    }

    pub fn upsert(&self, peer: PairedPeer) -> Result<PairedPeerSummary, String> {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard
            .peers
            .retain(|p| p.peer_device_id != peer.peer_device_id && p.pair_id != peer.pair_id);
        guard.peers.insert(0, peer.clone());
        if guard.peers.len() > MAX_PEERS {
            guard.peers.truncate(MAX_PEERS);
        }
        if let Some(ref path) = guard.path {
            save_file(path, &guard.device_id, &guard.peers)?;
        }
        Ok(PairedPeerSummary::from(&peer))
    }

    pub fn touch_sync(&self, pair_id: &str, ip: &str, port: u16) -> Result<(), String> {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        if let Some(idx) = guard.peers.iter().position(|p| p.pair_id == pair_id) {
            guard.peers[idx].last_ip = ip.to_string();
            guard.peers[idx].last_port = port;
            guard.peers[idx].last_synced_at = now_secs();
            if let Some(ref path) = guard.path {
                save_file(path, &guard.device_id, &guard.peers)?;
            }
        }
        Ok(())
    }

    pub fn remove(&self, pair_id: &str) -> Result<Vec<PairedPeerSummary>, String> {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let before = guard.peers.len();
        guard.peers.retain(|p| p.pair_id != pair_id);
        if guard.peers.len() != before {
            if let Some(ref path) = guard.path {
                save_file(path, &guard.device_id, &guard.peers)?;
            }
        }
        let mut out: Vec<PairedPeerSummary> = guard.peers.iter().map(PairedPeerSummary::from).collect();
        out.sort_by(|a, b| b.last_synced_at.cmp(&a.last_synced_at).then(b.paired_at.cmp(&a.paired_at)));
        Ok(out)
    }
}
