//! Account commands (100% plugin-driven, credentials owned by Rust SessionStore).

use super::Api;
use crate::net::base;
use serde_json::{json, Value};
use tauri::State;

fn normalize_account(value: Value, origin: &str) -> Result<Value, String> {
    let source = value.get("user").filter(|v| v.is_object()).unwrap_or(&value);
    let mut user = json!({});
    for key in ["id", "username", "nickname", "avatar", "avatar_color", "sign", "desc", "user_type", "counts", "interactions"] {
        if let Some(field) = source.get(key) { user[key] = field.clone(); }
    }
    if !user.get("id").and_then(Value::as_i64).is_some_and(|id| id > 0) {
        return Err("账号资料响应无效，请重新登录".into());
    }
    let interactions = value.get("interactions").or_else(|| user.get("interactions")).cloned();
    if let Some(ref interactions) = interactions { user["interactions"] = interactions.clone(); }
    let mut result = json!({"user": user, "origin": origin});
    if let Some(interactions) = interactions { result["interactions"] = interactions; }
    Ok(result)
}

fn normalize_account_history(value: Value) -> Result<Value, String> {
    let items = value.get("items").and_then(Value::as_array).ok_or("观看历史响应无效")?;
    let pagination = value.get("pagination").filter(|v| v.is_object()).ok_or("观看历史分页信息无效")?;
    let items: Vec<Value> = items.iter().filter_map(|item| {
        if item.get("target_type").and_then(Value::as_str) != Some("video") { return None; }
        let id = item.get("id")?.as_i64()?;
        let video_id = item.get("video_id")?.as_i64()?;
        if id <= 0 || video_id <= 0 { return None; }
        Some(json!({"id": id, "video_id": video_id, "target_type": "video",
            "last_ep": item.get("last_ep").and_then(Value::as_u64).unwrap_or(1).max(1),
            "updated_at": item.get("updated_at").and_then(Value::as_str).unwrap_or("")}))
    }).collect();
    for field in ["page", "pages", "size", "total"] {
        if pagination.get(field).and_then(Value::as_u64).is_none() { return Err("观看历史分页信息无效".into()); }
    }
    Ok(json!({"items": items, "pagination": pagination}))
}

#[tauri::command]
pub async fn api_login(
    state: State<'_, Api>,
    username: String,
    password: String,
    expected_user_id: Option<i64>,
    expected_origin: Option<String>,
    credential_origin: Option<String>,
) -> Result<Value, String> {
    crate::net::refresh_client();
    let (origin, revision) = match (expected_user_id, expected_origin.as_deref(), credential_origin.as_deref()) {
        (None, None, None) => (base(), state.session.revision()),
        (Some(id), Some(expected), Some(saved)) => {
            let session = state.account_session(Some(id), Some(expected))?;
            crate::session::verify_relogin_origins(saved, expected).await?;
            (session.origin, session.revision)
        }
        _ => return Err("自动重新登录缺少账号或线路信息".into()),
    };
    let data = crate::source::invoke_active(
        "login",
        json!({ "username": username, "password": password }),
        None,
        Some(origin.clone()),
    )
    .await?;
    if base() != origin {
        return Err("登录期间线路已变化，请重新登录".into());
    }
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "登录返回缺少 token".to_string())?
        .to_string();
    let account = normalize_account(data, &origin)?;
    state.session.commit_login(revision, &origin, expected_user_id, token, account["user"].clone())?;
    Ok(account)
}

#[tauri::command]
pub async fn api_register(
    state: State<'_, Api>,
    username: String,
    password: String,
    email: String,
) -> Result<Value, String> {
    let origin = base();
    let revision = state.session.revision();
    let data = crate::source::invoke_active(
        "register",
        json!({ "username": username, "password": password, "email": email }),
        None,
        Some(origin.clone()),
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "注册返回缺少 token".to_string())?
        .to_string();
    let account = normalize_account(data, &origin)?;
    let user = account["user"].clone();
    if base() != origin {
        return Err("注册期间线路已变化，请重新登录".into());
    }
    if !state.session.set_if_revision(revision, &origin, token, user) {
        return Err("注册期间账号状态已变化，请重试".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_logout(state: State<'_, Api>, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let session = state.account_session(expected_user_id, expected_origin.as_deref())?;
    let _ = crate::source::invoke_active(
        "logout",
        json!({}),
        Some(session.token.clone()),
        Some(session.origin.clone()),
    )
    .await;
    if !state.session.clear_if_current(&session) {
        return Err("账号已变化，请重试".into());
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn api_me(state: State<'_, Api>, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let session = state.account_session(expected_user_id, expected_origin.as_deref())?;
    let me = crate::source::invoke_active(
        "me",
        json!({}),
        Some(session.token.clone()),
        Some(session.origin.clone()),
    )
    .await?;
    let account = normalize_account(me, &session.origin)?;
    if base() != session.origin {
        return Err("读取账号期间线路已变化".into());
    }
    if !state.session.update_user_if_current(&session, account["user"].clone()) {
        return Err("读取账号期间登录状态已变化".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_account_history(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, page: u32, size: u32) -> Result<Value, String> {
    let value = state
        .account_source_call(
            "accountHistory",
            json!({ "page": page.max(1), "size": size.clamp(1, 100) }),
            Some(expected_user_id),
            Some(&expected_origin),
        )
        .await?;
    normalize_account_history(value)
}

#[tauri::command]
pub async fn api_account_history_record(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, video_id: i64, ep: u32) -> Result<Value, String> {
    if video_id <= 0 || ep == 0 { return Err("观看记录参数无效".into()); }
    state
        .account_source_call(
            "accountHistoryRecord",
            json!({ "videoId": video_id, "ep": ep }),
            Some(expected_user_id),
            Some(&expected_origin),
        )
        .await
}

#[tauri::command]
pub async fn api_account_history_delete(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, ids: Vec<i64>) -> Result<Value, String> {
    if ids.is_empty() || ids.len() > 200 || ids.iter().any(|id| *id <= 0) { return Err("观看记录参数无效".into()); }
    state
        .account_source_call(
            "accountHistoryDelete",
            json!({ "ids": ids }),
            Some(expected_user_id),
            Some(&expected_origin),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::{normalize_account, normalize_account_history};
    use serde_json::json;

    #[test]
    fn account_snapshot_accepts_direct_and_wrapped_profiles_without_credentials() {
        for value in [json!({"id": 7, "nickname": "fixture", "token": "not-for-ipc", "interactions": {"favorite_video_ids": [9]}}),
            json!({"user": {"id": 7, "nickname": "fixture"}, "token": "not-for-ipc", "interactions": {"favorite_video_ids": [9]}})] {
            let result = normalize_account(value, "https://example.com").unwrap();
            assert_eq!(result["user"]["id"], 7);
            assert_eq!(result["interactions"]["favorite_video_ids"], json!([9]));
            assert_eq!(result["origin"], "https://example.com");
            assert!(result.get("token").is_none());
            assert!(result["user"].get("token").is_none());
        }
        assert!(normalize_account(json!({"user": {"nickname": "invalid"}}), "https://example.com").is_err());
        assert!(normalize_account(json!({"id": 0}), "https://example.com").is_err());
    }

    #[test]
    fn account_history_preserves_row_identity_and_pagination_without_media_metadata() {
        let value = normalize_account_history(json!({
            "items": [
                {"id": 11, "video_id": 42, "target_type": "video", "last_ep": 3, "updated_at": "2026-01-01T00:00:00Z"},
                {"id": 12, "video_id": 43, "target_type": "post", "last_ep": 1}
            ],
            "pagination": {"page": 1, "pages": 1, "size": 20, "total": 1}
        }))
        .unwrap();
        assert_eq!(value["items"].as_array().unwrap().len(), 1);
        assert_eq!(value["items"][0]["video_id"], 42);
    }
}
