//! Feed, topics, tags, search, posts and user list commands (100% plugin-driven).

use super::Api;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn api_feed(state: State<'_, Api>, page: u32, size: u32) -> Result<Value, String> {
    state.source_call("home", json!({ "page": page, "size": size })).await
}

#[tauri::command]
pub async fn api_original_videos(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
    json_only: Option<bool>,
) -> Result<Value, String> {
    state
        .source_call(
            "originalVideos",
            json!({ "cate": cate, "page": page, "size": size, "sort": sort, "jsonOnly": json_only.unwrap_or(false) }),
        )
        .await
}

#[tauri::command]
pub async fn api_topics(state: State<'_, Api>) -> Result<Value, String> {
    state.source_call("topics", json!({})).await
}

#[tauri::command]
pub async fn api_topic(
    state: State<'_, Api>,
    slug: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .source_call("topic", json!({ "slug": slug, "page": page.max(1), "size": size.clamp(1, 100) }))
        .await
}

#[tauri::command]
pub async fn api_tags(state: State<'_, Api>) -> Result<Value, String> {
    state.source_call("tags", json!({})).await
}

#[tauri::command]
pub async fn api_hot_tags(state: State<'_, Api>) -> Result<Value, String> {
    state.source_call("hotTags", json!({})).await
}

#[tauri::command]
pub async fn api_tag_videos(
    state: State<'_, Api>,
    tag: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    state
        .source_call("tagVideos", json!({ "tag": tag, "page": page, "size": size, "sort": sort }))
        .await
}

#[tauri::command]
pub async fn api_post_tag(
    state: State<'_, Api>,
    tag: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .source_call("postTag", json!({ "tag": tag, "page": page.max(1), "size": size.clamp(1, 100) }))
        .await
}

#[tauri::command]
pub async fn api_category(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
    json_only: Option<bool>,
) -> Result<Value, String> {
    state
        .source_call(
            "category",
            json!({ "cate": cate, "page": page, "size": size, "sort": sort, "jsonOnly": json_only.unwrap_or(false) }),
        )
        .await
}

#[tauri::command]
pub async fn api_rank(state: State<'_, Api>, kind: String) -> Result<Value, String> {
    state.source_call("rank", json!({ "kind": kind })).await
}

#[tauri::command]
pub async fn api_search(
    state: State<'_, Api>,
    q: String,
    page: u32,
    size: u32,
    kind: Option<String>,
) -> Result<Value, String> {
    state
        .source_call("search", json!({ "q": q, "page": page, "size": size, "kind": kind }))
        .await
}

#[tauri::command]
pub async fn api_search_hot(state: State<'_, Api>) -> Result<Value, String> {
    state.source_call("searchHot", json!({})).await
}

#[tauri::command]
pub async fn api_posts(
    state: State<'_, Api>,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    state
        .source_call("posts", json!({ "page": page, "size": size, "sort": sort }))
        .await
}

#[tauri::command]
pub async fn api_post(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.source_call("post", json!({ "id": id })).await
}

#[tauri::command]
pub async fn api_post_playback(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.source_call("postPlayback", json!({ "id": id })).await
}

#[tauri::command]
pub async fn api_post_categories(state: State<'_, Api>) -> Result<Value, String> {
    state.source_call("postCategories", json!({})).await
}

#[tauri::command]
pub async fn api_post_category(
    state: State<'_, Api>,
    route: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    state
        .source_call("postCategory", json!({ "route": route, "page": page, "size": size, "sort": sort }))
        .await
}

#[tauri::command]
pub async fn api_related(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.source_call("related", json!({ "id": id })).await
}

#[tauri::command]
pub async fn api_following(state: State<'_, Api>, page: u32, size: u32) -> Result<Value, String> {
    state
        .account_source_call("following", json!({ "page": page, "size": size }), None, None)
        .await
}

#[tauri::command]
pub async fn api_user(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.source_call("user", json!({ "id": id })).await
}

#[tauri::command]
pub async fn api_user_stats(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.source_call("userStats", json!({ "id": id })).await
}

#[tauri::command]
pub async fn api_user_videos(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .source_call("userVideos", json!({ "id": id, "page": page, "size": size }))
        .await
}
