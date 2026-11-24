//! Tauri commands and active-source dispatch helpers.

use super::manifest::{
    decode_package_input, encode_share_code, validate_package, MAX_PACKAGE_JSON_BYTES,
};
use super::runtime::{host_http_request, invoke_source};
use super::store::{InstalledSourceSummary, SourceStateSnapshot};
use super::verify::verify_package;
use super::store_arc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUpdateOutcome {
    pub updated: bool,
    pub from_version: String,
    pub to_version: String,
    pub summary: InstalledSourceSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTestOutcome {
    pub ok: bool,
    pub ms: u64,
    pub method: String,
    pub item_count: usize,
    pub sample_title: Option<String>,
    pub error: Option<String>,
}

async fn resolve_raw_input(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        let resp = host_http_request(
            "GET",
            trimmed,
            &HashMap::new(),
            None,
            None,
            MAX_PACKAGE_JSON_BYTES,
            15,
        )
        .await?;
        let status = resp.get("status").and_then(Value::as_u64).unwrap_or(0);
        if !(200..300).contains(&status) {
            return Err(format!("拉取远程视频源失败（HTTP {status}）"));
        }
        return Ok(resp
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub async fn source_state() -> Result<SourceStateSnapshot, String> {
    Ok(store_arc().snapshot())
}

#[tauri::command]
pub async fn source_import(input: String, activate: Option<bool>) -> Result<InstalledSourceSummary, String> {
    let raw = resolve_raw_input(&input).await?;
    let pkg = decode_package_input(&raw)?;
    validate_package(&pkg)?;
    let store = store_arc();
    let sig_info = verify_package(&pkg, store.allow_untrusted())?;
    // Smoke-test loading & optional init() inside QuickJS before installing!
    invoke_source(store.clone(), pkg.clone(), "init", json!({}), Some(6)).await?;
    let summary = store.install(pkg, sig_info, activate.unwrap_or(false))?;
    if activate == Some(true) {
        let _ = store.activate(Some(summary.id.clone()));
        sync_active_source_side_effects();
        return Ok(InstalledSourceSummary { active: true, ..summary });
    }
    sync_active_source_side_effects();
    Ok(summary)
}

fn sync_active_source_side_effects() {
    crate::media::clear_caches();
    let origin = active_default_origin();
    crate::net::sync_base_for_source(&origin);
}

#[tauri::command]
pub async fn source_activate(id: Option<String>) -> Result<SourceStateSnapshot, String> {
    let snap = store_arc().activate(id)?;
    sync_active_source_side_effects();
    Ok(snap)
}

#[tauri::command]
pub async fn source_rollback(id: String) -> Result<InstalledSourceSummary, String> {
    let res = store_arc().rollback(&id)?;
    sync_active_source_side_effects();
    Ok(res)
}

#[tauri::command]
pub async fn source_remove(id: String) -> Result<SourceStateSnapshot, String> {
    let snap = store_arc().remove(&id)?;
    sync_active_source_side_effects();
    Ok(snap)
}

#[tauri::command]
pub async fn source_set_allow_untrusted(allow: bool) -> Result<SourceStateSnapshot, String> {
    store_arc().set_allow_untrusted(allow)
}

#[tauri::command]
pub async fn source_export_share_code(id: String) -> Result<String, String> {
    let pkg = store_arc()
        .get_package(&id)
        .ok_or_else(|| "视频源不存在".to_string())?;
    encode_share_code(&pkg)
}

#[tauri::command]
pub async fn source_check_update(id: String) -> Result<SourceUpdateOutcome, String> {
    let store = store_arc();
    let current = store
        .get_package(&id)
        .ok_or_else(|| "视频源不存在".to_string())?;
    if current.update_urls.is_empty() {
        return Err("该视频源未配置更新链接（updateUrls）；请直接复制新口令覆盖导入".into());
    }
    let from_version = current.manifest.version.clone();
    let mut last_err = String::from("所有更新链接均不可用");
    for url in &current.update_urls {
        match resolve_raw_input(url).await {
            Ok(raw) => {
                let candidate = match decode_package_input(&raw) {
                    Ok(p) => p,
                    Err(e) => { last_err = e; continue; }
                };
                if candidate.manifest.id != id {
                    last_err = "远程视频源 id 与当前源不一致，已拒绝覆盖".into();
                    continue;
                }
                if let Err(e) = validate_package(&candidate) {
                    last_err = e;
                    continue;
                }
                let sig_info = match verify_package(&candidate, store.allow_untrusted()) {
                    Ok(s) => s,
                    Err(e) => { last_err = e; continue; }
                };
                if !store.is_newer_than_installed(&id, &candidate.manifest.version) {
                    let snap = store.snapshot();
                    let summary = snap
                        .sources
                        .into_iter()
                        .find(|s| s.id == id)
                        .ok_or_else(|| "视频源不存在".to_string())?;
                    return Ok(SourceUpdateOutcome {
                        updated: false,
                        from_version: from_version.clone(),
                        to_version: from_version,
                        summary,
                    });
                }
                if let Err(e) = invoke_source(store.clone(), candidate.clone(), "init", json!({}), Some(6)).await {
                    last_err = format!("新版视频源初始化失败，已保留旧版：{e}");
                    continue;
                }
                let to_version = candidate.manifest.version.clone();
                let summary = store.install(candidate, sig_info, false)?;
                return Ok(SourceUpdateOutcome {
                    updated: true,
                    from_version,
                    to_version,
                    summary,
                });
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn source_test(id: String, query: Option<String>) -> Result<SourceTestOutcome, String> {
    let store = store_arc();
    let pkg = store
        .get_package(&id)
        .ok_or_else(|| "视频源不存在".to_string())?;
    let started = Instant::now();
    let q = query.unwrap_or_default().trim().to_string();
    let (method, input) = if !q.is_empty() {
        ("search", json!({ "q": q, "page": 1, "size": 5, "kind": "video" }))
    } else if pkg.manifest.capabilities.home {
        ("home", json!({ "page": 1, "size": 5 }))
    } else {
        ("search", json!({ "q": "都市", "page": 1, "size": 5, "kind": "video" }))
    };
    match invoke_source(store, pkg, method, input, Some(12)).await {
        Ok(val) => {
            let items = val.get("items").and_then(Value::as_array);
            let item_count = items.map_or(0, Vec::len);
            let sample_title = items
                .and_then(|arr| arr.first())
                .and_then(|v| v.get("title"))
                .and_then(Value::as_str)
                .map(str::to_string);
            Ok(SourceTestOutcome {
                ok: true,
                ms: started.elapsed().as_millis() as u64,
                method: method.into(),
                item_count,
                sample_title,
                error: None,
            })
        }
        Err(e) => Ok(SourceTestOutcome {
            ok: false,
            ms: started.elapsed().as_millis() as u64,
            method: method.into(),
            item_count: 0,
            sample_title: None,
            error: Some(e),
        }),
    }
}

/* ───────────────────── Pure-shell active-source dispatch ───────────────────── */

pub(crate) fn active_origins() -> Vec<String> {
    store_arc()
        .active_package()
        .map(|p| p.manifest.network.origins)
        .unwrap_or_default()
}

pub(crate) fn active_default_origin() -> String {
    active_origins().into_iter().next().unwrap_or_default()
}

pub(crate) fn active_image_decrypt() -> Option<([u8; 16], [u8; 16])> {
    let pkg = store_arc().active_package()?;
    let cfg = pkg.manifest.media?.image_decrypt?;
    super::manifest::parse_image_decrypt_bytes(&cfg).ok()
}

pub(crate) async fn invoke_active(
    method: &str,
    input: Value,
    auth_token: Option<String>,
    base_override: Option<String>,
) -> Result<Value, String> {
    let store = store_arc();
    let pkg = store
        .active_package()
        .ok_or_else(|| "尚未导入视频源，请先在「视频源」中导入口令或链接".to_string())?;
    super::runtime::invoke_source_with_ctx(store, pkg, method, input, auth_token, base_override, None).await
}

fn non_empty_str(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null() && x.as_str().is_some_and(|s| !s.trim().is_empty()))
}

/// Shared play-info normalizer used by plugin `playback`.
pub(crate) fn normalize_play_info(info: &mut Value) {
    let Some(obj) = info.as_object_mut() else { return };
    for (field, key) in [("video_url", "main"), ("video_url_hevc", "hevc")] {
        let url = obj
            .get("streams")
            .and_then(|st| st.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned);
        if let Some(url) = url {
            if non_empty_str(obj.get(field)).is_none() {
                obj.insert(field.into(), json!(url));
            }
        }
    }
    if non_empty_str(obj.get("video_url")).is_none() {
        if let Some(hevc) = non_empty_str(obj.get("video_url_hevc")).cloned() {
            obj.insert("video_url".into(), hevc);
        }
    }
}

pub(crate) fn has_play_url(info: &Value) -> bool {
    non_empty_str(info.get("video_url")).is_some() || non_empty_str(info.get("video_url_hevc")).is_some()
}
