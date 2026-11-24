//! Like, favorite and follow commands for videos and posts (100% plugin-driven).

use super::Api;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn api_like(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    on: bool,
    expected_user_id: Option<i64>,
    expected_origin: Option<String>,
) -> Result<Value, String> {
    state
        .account_source_call(
            "like",
            json!({ "id": id, "ep": ep, "on": on }),
            expected_user_id,
            expected_origin.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn api_collect(
    state: State<'_, Api>,
    id: i64,
    on: bool,
    expected_user_id: Option<i64>,
    expected_origin: Option<String>,
) -> Result<Value, String> {
    state
        .account_source_call(
            "collect",
            json!({ "id": id, "on": on }),
            expected_user_id,
            expected_origin.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn api_follow(
    state: State<'_, Api>,
    uid: i64,
    on: bool,
    expected_user_id: Option<i64>,
    expected_origin: Option<String>,
) -> Result<Value, String> {
    state
        .account_source_call(
            "follow",
            json!({ "uid": uid, "on": on }),
            expected_user_id,
            expected_origin.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn api_post_like(
    state: State<'_, Api>,
    id: i64,
    on: bool,
    expected_user_id: Option<i64>,
    expected_origin: Option<String>,
) -> Result<Value, String> {
    state
        .account_source_call(
            "postLike",
            json!({ "id": id, "on": on }),
            expected_user_id,
            expected_origin.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn api_post_collect(
    state: State<'_, Api>,
    id: i64,
    on: bool,
    expected_user_id: Option<i64>,
    expected_origin: Option<String>,
) -> Result<Value, String> {
    state
        .account_source_call(
            "postCollect",
            json!({ "id": id, "on": on }),
            expected_user_id,
            expected_origin.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn api_post_comments(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .source_call("postComments", json!({ "id": id, "page": page, "size": size }))
        .await
}
