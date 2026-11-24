//! Video detail, playback and comments.

use super::Api;
use serde_json::{json, Value};
use tauri::State;

use crate::source::commands::{has_play_url, normalize_play_info};

#[tauri::command]
pub async fn api_video(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    if let Some(res) = crate::source::try_detail(id).await { return res; }
    state.get(&format!("/api/videos/{id}")).await
}

#[tauri::command]
pub async fn api_play(state: State<'_, Api>, id: i64, ep: u32) -> Result<Value, String> {
    if let Some(res) = crate::source::try_play(id, ep).await { return res; }
    // 优先走新接口；失败或没有可用地址时退回旧接口，两者都不行就返回新接口的结果/错误。
    let primary = state
        .post(
            &format!("/api/videos/{id}/episodes/{ep}/playback"),
            Some(json!({})),
        )
        .await
        .map(|mut info| {
            normalize_play_info(&mut info);
            info
        });
    if let Ok(info) = &primary {
        if has_play_url(info) {
            return primary;
        }
    }
    match state
        .get(&format!("/api/videos/{id}/play?ep={ep}&page_texts=0"))
        .await
    {
        Ok(mut legacy) => {
            normalize_play_info(&mut legacy);
            if has_play_url(&legacy) || primary.is_err() {
                Ok(legacy)
            } else {
                primary
            }
        }
        Err(_) => primary,
    }
}

#[tauri::command]
pub async fn api_comments(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!(
            "/api/videos/{id}/comments?ep={ep}&page={page}&size={size}"
        ))
        .await
}

#[tauri::command]
pub async fn api_comment_send(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    text: String,
    reply_id: Option<i64>,
) -> Result<Value, String> {
    let mut body = json!({ "text": text });
    let path = match reply_id {
        Some(rid) if rid > 0 => {
            body["reply_id"] = json!(rid);
            format!("/api/videos/{id}/comments")
        }
        _ => format!("/api/videos/{id}/comments?ep={ep}"),
    };
    state.account_request("POST", &path, Some(body), None, None).await
}

#[cfg(test)]
mod tests {
    use super::{has_play_url, normalize_play_info};
    use serde_json::json;

    #[test]
    fn hevc_only_stream_is_recognized_as_playable_fallback() {
        let mut info = json!({
            "id": "42",
            "ep": 1,
            "streams": {
                "main": "",
                "hevc": "https://cdn.example/video/hevc.m3u8"
            }
        });
        normalize_play_info(&mut info);
        assert!(has_play_url(&info));
        assert_eq!(info["video_url_hevc"], "https://cdn.example/video/hevc.m3u8");
        assert_eq!(info["video_url"], "https://cdn.example/video/hevc.m3u8");
    }
}
