//! Selective WebView cache maintenance.
//!
//! `clear_all_browsing_data` is intentionally not used: it also removes cookies,
//! local/session storage and other account state. Linux WebKitGTK exposes the
//! cache data classes separately, so the setting can purge HTTP/media cache
//! without touching login or local preferences.

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// Bounded in-memory cache with automatic LRU eviction on both item count and byte limit.
pub struct LruCache<V> {
    entries: HashMap<String, (V, usize, u64)>,
    total_bytes: usize,
    max_items: usize,
    max_bytes: usize,
    clock: u64,
}

impl<V> LruCache<V> {
    pub fn new(max_items: usize, max_bytes: usize) -> Self {
        Self { entries: HashMap::new(), total_bytes: 0, max_items, max_bytes, clock: 0 }
    }

    fn tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1);
        self.clock
    }

    pub fn get(&mut self, key: &str) -> Option<V>
    where
        V: Clone,
    {
        let next = self.tick();
        let entry = self.entries.get_mut(key)?;
        entry.2 = next;
        Some(entry.0.clone())
    }

    pub fn insert(&mut self, key: String, value: V, bytes: usize) {
        if self.max_items == 0 || bytes > self.max_bytes {
            return;
        }
        if let Some((_, old_bytes, _)) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(old_bytes);
        }
        while !self.entries.is_empty()
            && (self.entries.len() >= self.max_items || self.total_bytes.saturating_add(bytes) > self.max_bytes)
        {
            let Some(victim) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, _, ts))| *ts)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((_, evicted_bytes, _)) = self.entries.remove(&victim) {
                self.total_bytes = self.total_bytes.saturating_sub(evicted_bytes);
            }
        }
        let ts = self.tick();
        self.entries.insert(key, (value, bytes, ts));
        self.total_bytes = self.total_bytes.saturating_add(bytes);
    }

    #[cfg(test)]
    pub fn remove(&mut self, key: &str) {
        if let Some((_, bytes, _)) = self.entries.remove(key) {
            self.total_bytes = self.total_bytes.saturating_sub(bytes);
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
    }

    pub fn stats(&self) -> (usize, usize, usize) {
        (self.entries.len(), self.total_bytes, self.max_bytes)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsReport {
    pub used_bytes: u64,
    pub limit_bytes: u64,
    pub image_count: usize,
    pub segment_count: usize,
    pub playlist_count: usize,
}

fn dir_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

pub fn cache_stats(app: &tauri::AppHandle) -> CacheStatsReport {
    use tauri::Manager;
    let (image_count, segment_count, playlist_count, mem_used, limit_bytes) =
        crate::media::cache_stats();
    let disk_used = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir_bytes(&dir.join("updates")))
        .unwrap_or(0);
    CacheStatsReport {
        used_bytes: mem_used.saturating_add(disk_used),
        limit_bytes,
        image_count,
        segment_count,
        playlist_count,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearReport {
    /// Whether a platform WebView HTTP/media cache was selectively cleared.
    pub web_cache: bool,
    pub platform: &'static str,
}

pub async fn clear_web_cache(webview: &tauri::Webview) -> Result<CacheClearReport, String> {
    use tauri::Manager;
    if let Ok(dir) = webview.app_handle().path().app_cache_dir() {
        crate::updater::cleanup_tv_updates(&dir);
    }
    #[cfg(target_os = "linux")]
    {
        linux::clear(webview).await?;
        return Ok(CacheClearReport {
            web_cache: true,
            platform: "linux",
        });
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Tauri only exposes clear_all_browsing_data on the other platforms,
        // which would also delete cookies and local settings. Keep the bounded
        // in-memory media caches cleared by the caller instead of risking login.
        let _ = webview;
        Ok(CacheClearReport {
            web_cache: false,
            platform: std::env::consts::OS,
        })
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;
    use webkit2gtk::{WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes};

    fn safe_cache_types() -> WebsiteDataTypes {
        // Deliberately excludes COOKIES, LOCAL_STORAGE, SESSION_STORAGE,
        // INDEXEDDB_DATABASES, SERVICE_WORKER_REGISTRATIONS and HSTS.
        WebsiteDataTypes::MEMORY_CACHE
            | WebsiteDataTypes::DISK_CACHE
            | WebsiteDataTypes::OFFLINE_APPLICATION_CACHE
    }

    pub(super) async fn clear(webview: &tauri::Webview) -> Result<(), String> {
        let (done, result) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform| {
                let Some(manager) = platform.inner().website_data_manager() else {
                    let _ = done.send(Err("WebKit 数据管理器不可用".to_string()));
                    return;
                };
                manager.clear(
                    safe_cache_types(),
                    webkit2gtk::glib::TimeSpan::from_seconds(0),
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |outcome| {
                        let _ = done.send(outcome.map_err(|error| error.to_string()));
                    },
                );
            })
            .map_err(|error| format!("无法访问 WebView：{error}"))?;

        match tokio::time::timeout(Duration::from_secs(20), result).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(error))) => Err(format!("WebKit 缓存清理失败：{error}")),
            Ok(Err(_)) => Err("WebKit 缓存清理未返回结果".to_string()),
            Err(_) => Err("WebKit 缓存清理超时".to_string()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::safe_cache_types;
        use webkit2gtk::WebsiteDataTypes;

        #[test]
        fn selective_clear_never_includes_account_or_preference_storage() {
            let types = safe_cache_types();
            assert!(types.contains(WebsiteDataTypes::MEMORY_CACHE));
            assert!(types.contains(WebsiteDataTypes::DISK_CACHE));
            assert!(!types.intersects(
                WebsiteDataTypes::COOKIES
                    | WebsiteDataTypes::LOCAL_STORAGE
                    | WebsiteDataTypes::SESSION_STORAGE
                    | WebsiteDataTypes::INDEXEDDB_DATABASES
                    | WebsiteDataTypes::SERVICE_WORKER_REGISTRATIONS
                    | WebsiteDataTypes::HSTS_CACHE
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CacheClearReport;

    #[test]
    fn report_matches_frontend_camel_case_contract() {
        let value = serde_json::to_value(CacheClearReport {
            web_cache: true,
            platform: "linux",
        })
        .unwrap();
        assert_eq!(value["webCache"], true);
        assert_eq!(value["platform"], "linux");
    }
}
