//! Video detail, playback and comments (100% plugin-driven).

use super::Api;
use crate::source::commands::{has_play_url, normalize_play_info};
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn api_video(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.source_call("detail", json!({ "id": id })).await
}

#[tauri::command]
pub async fn api_play(state: State<'_, Api>, id: i64, ep: u32) -> Result<Value, String> {
    let mut info = state
        .source_call("playback", json!({ "id": id, "ep": ep }))
        .await?;
    normalize_play_info(&mut info);
    Ok(info)
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
        .source_call("comments", json!({ "id": id, "ep": ep, "page": page, "size": size }))
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
    state
        .account_source_call(
            "commentSend",
            json!({ "id": id, "ep": ep, "text": text, "replyId": reply_id }),
            None,
            None,
        )
        .await
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
