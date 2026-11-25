use crate::api::Api;
use serde_json::{json, Value};
use tauri::State;

/// Author directory via active source plugin (`popularAuthors`).
#[tauri::command]
pub async fn api_popular_authors(
    state: State<'_, Api>,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    let page = page.max(1);
    let size = size.clamp(1, 100);
    state
        .source_call("popularAuthors", json!({ "page": page, "size": size }))
        .await
}
