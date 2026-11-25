//! Candidate probing and automatic line selection via the active source plugin.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::mirror::{is_fixed, is_trusted_mirror, mirrors, MIRROR_MAX};

const AUTO_PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const MAIN_AUTO_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const AUTO_MIRROR_MAX: usize = 10;

/// Validate normalized feed/probe data returned by the active source plugin.
pub(crate) fn healthy_video_data(data: &Value) -> bool {
    if data.get("ok").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let Some(items) = data.get("items").and_then(Value::as_array) else {
        return false;
    };
    let Some(pagination) = data.get("pagination").and_then(Value::as_object) else {
        return false;
    };
    let integer = |key: &str| pagination.get(key).and_then(Value::as_u64);
    if integer("page").is_none_or(|n| n == 0)
        || integer("size").is_none_or(|n| n == 0)
        || integer("pages").is_none()
        || integer("total").is_none()
    {
        return false;
    }
    items.iter().all(|item| {
        item.get("id")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0)
            && item
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|title| !title.trim().is_empty())
    })
}

#[derive(Clone)]
pub struct Hit {
    pub tier: &'static str,
    pub url: String,
    pub ok: bool,
    pub reachable: bool,
    pub ms: u64,
    pub status: Option<u16>,
    pub(crate) error: Option<String>,
}

impl Hit {
    fn json(&self) -> Value {
        let mut value = json!({ "tier": self.tier, "url": self.url, "ok": self.ok,
            "reachable": self.reachable, "ms": self.ms, "status": self.status });
        if let Some(error) = &self.error {
            value["error"] = json!(error);
        }
        value
    }
}

async fn probe_hit(tier: &'static str, raw: &str) -> Hit {
    probe_hit_with_timeout(tier, raw, AUTO_PROBE_TIMEOUT).await
}

async fn probe_hit_with_timeout(tier: &'static str, raw: &str, timeout: Duration) -> Hit {
    let mut hit = Hit {
        tier,
        url: raw.to_owned(),
        ok: false,
        reachable: false,
        ms: 0,
        status: None,
        error: None,
    };
    let Some(origin) = crate::net::normalize_base(raw) else {
        hit.error = Some("线路必须是安全 HTTPS origin".into());
        return hit;
    };
    hit.url = origin.clone();
    let started = Instant::now();
    let fut = async {
        match crate::source::invoke_active(
            "probeLine",
            json!({ "baseUrl": origin }),
            None,
            Some(origin.clone()),
        )
        .await
        {
            Ok(v) => Ok(v),
            Err(e) if e.contains("未实现") => {
                crate::source::invoke_active(
                    "home",
                    json!({ "page": 1, "size": 1 }),
                    None,
                    Some(origin.clone()),
                )
                .await
            }
            Err(e) => Err(e),
        }
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(data)) => {
            hit.reachable = true;
            hit.status = Some(200);
            hit.ok = healthy_video_data(&data);
            if !hit.ok {
                hit.error = Some("接口未返回有效视频列表数据".into());
            }
        }
        Ok(Err(error)) => {
            hit.error = Some(error);
        }
        Err(_) => {
            hit.error = Some(format!("视频接口探测超时（{} 秒）", timeout.as_secs()));
        }
    }
    hit.ms = started.elapsed().as_millis() as u64;
    hit
}

pub async fn probe(urls: Vec<String>) -> Value {
    let mut out = Vec::new();
    for chunk in urls[..urls.len().min(MIRROR_MAX)].chunks(6) {
        let mut handles = Vec::new();
        for origin in chunk {
            let origin = origin.clone();
            handles.push(tokio::spawn(async move { probe_hit("mirror", &origin).await }));
        }
        for handle in handles {
            if let Ok(hit) = handle.await {
                out.push(hit.json());
            }
        }
    }
    json!(out)
}

pub(crate) fn auto_candidates(
    items: &[Value],
    current: &str,
    trusted: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let current = crate::net::normalize_base(current);
    let published: Vec<_> = items
        .iter()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
        .filter_map(crate::net::normalize_base)
        .filter(|origin| !is_fixed(origin) && trusted(origin))
        .collect();
    if let Some(origin) = current.filter(|origin| published.contains(origin)) {
        seen.insert(origin.clone());
        candidates.push(origin);
    }
    for origin in published {
        if candidates.len() >= AUTO_MIRROR_MAX {
            break;
        }
        if seen.insert(origin.clone()) {
            candidates.push(origin);
        }
    }
    candidates
}

pub(crate) fn pick_from_hits(hits: &[Hit]) -> Value {
    let winner = hits.iter().filter(|hit| hit.ok).min_by_key(|hit| hit.ms);
    let candidates: Vec<_> = hits.iter().map(Hit::json).collect();
    match winner {
        Some(hit) => json!({ "base": hit.url, "tier": hit.tier, "ms": hit.ms,
            "reason": if hit.tier == "main" { "main-ok" } else { "mirror-ok" }, "candidates": candidates }),
        None => json!({ "base": "", "tier": "none", "ms": 0, "reason": "all-down", "candidates": candidates }),
    }
}

pub async fn auto_pick() -> Value {
    let origins = crate::source::active_origins();
    if origins.is_empty() {
        return json!({ "base": "", "tier": "none", "ms": 0, "reason": "no-source", "candidates": [] });
    }
    let mirrors_task = tokio::spawn(mirrors());
    let mut hits = vec![probe_hit_with_timeout("main", &origins[0], MAIN_AUTO_PROBE_TIMEOUT).await];
    if hits[0].ok {
        mirrors_task.abort();
        return pick_from_hits(&hits);
    }
    let listing = match mirrors_task.await {
        Ok(res) => res,
        Err(_) => Err("镜像线路任务异常终止".into()),
    };
    if let Ok(listing) = &listing {
        let items = listing
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut handles = Vec::new();
        for origin in auto_candidates(items, &crate::net::base(), is_trusted_mirror) {
            handles.push(tokio::spawn(async move { probe_hit("mirror", &origin).await }));
        }
        for handle in handles {
            if let Ok(hit) = handle.await {
                hits.push(hit);
            }
        }
    }
    let mut result = pick_from_hits(&hits);
    if let Err(error) = listing {
        result["mirror_error"] = json!(error);
    }
    result
}

pub async fn try_main() -> Value {
    let main_origin = crate::source::active_default_origin();
    if main_origin.is_empty() {
        return json!({ "ok": false, "base": "", "tier": "none", "ms": 0, "status": null, "error": "尚未导入视频源" });
    }
    let hit = probe_hit("main", &main_origin).await;
    let mut result = hit.json();
    result["base"] = json!(hit.url);
    result
}

pub async fn health() -> Value {
    crate::net::refresh_client();
    let cur = crate::net::base();
    if cur.is_empty() {
        return json!({ "ok": false, "base": "", "tier": "none", "ms": 0, "status": null, "error": "尚未导入视频源" });
    }
    let hit = probe_hit("current", &cur).await;
    let mut result = hit.json();
    result["base"] = json!(hit.url);
    result
}
