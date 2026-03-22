use axum::extract::Json;
use serde::Deserialize;
use std::sync::Arc;

use super::adb::adb_shell;
use super::{ApiError, AppState};

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    Tap(TapParams),
    LongTap(TapParams),
    Swipe(SwipeParams),
    Pinch(PinchParams),
    Key(KeyParams),
    Type(TypeParams),
}

#[derive(Debug, Deserialize)]
pub struct TapParams {
    x: Option<i32>,
    y: Option<i32>,
    #[serde(rename = "ref")]
    ref_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SwipeParams {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    #[serde(default = "default_swipe_duration")]
    duration_ms: u32,
}

fn default_swipe_duration() -> u32 {
    300
}

#[derive(Debug, Deserialize)]
pub struct PinchParams {
    x: i32,
    y: i32,
    start_radius: i32,
    end_radius: i32,
    #[serde(default = "default_pinch_duration")]
    duration_ms: u32,
}

fn default_pinch_duration() -> u32 {
    500
}

#[derive(Debug, Deserialize)]
pub struct KeyParams {
    key: String,
}

#[derive(Debug, Deserialize)]
pub struct TypeParams {
    text: String,
}

pub async fn handler(
    state: Arc<AppState>,
    Json(action): Json<Action>,
) -> Result<Json<serde_json::Value>, ApiError> {
    match action {
        Action::Tap(p) => handle_tap(state.clone(), p, false).await?,
        Action::LongTap(p) => handle_tap(state.clone(), p, true).await?,
        Action::Swipe(p) => handle_swipe(p).await?,
        Action::Pinch(p) => handle_pinch(p).await?,
        Action::Key(p) => handle_key(p).await?,
        Action::Type(p) => handle_type(p).await?,
    }

    // Invalidate snapshot cache — the UI likely changed
    {
        let mut guard = state.snapshot_cache.lock().await;
        if let Some(cache) = guard.as_mut() {
            cache.invalidate();
        }
    }

    Ok(Json(serde_json::json!({"ok": true})))
}

async fn handle_tap(state: Arc<AppState>, p: TapParams, long: bool) -> Result<(), ApiError> {
    let (x, y) = if let Some(ref_id) = p.ref_id {
        let guard = state.snapshot_cache.lock().await;
        let cache = guard
            .as_ref()
            .ok_or_else(|| ApiError::BadRequest("no snapshot taken yet — call GET /api/snapshot first".into()))?;

        if !cache.is_valid() {
            return Err(ApiError::BadRequest(
                "snapshot expired or invalidated — call GET /api/snapshot to refresh".into(),
            ));
        }

        let bounds = cache
            .ref_bounds
            .get(&ref_id)
            .ok_or_else(|| ApiError::NotFound(format!("ref {ref_id} not in current snapshot")))?;
        let cx = (bounds.x1 + bounds.x2) / 2;
        let cy = (bounds.y1 + bounds.y2) / 2;
        (cx, cy)
    } else if let (Some(x), Some(y)) = (p.x, p.y) {
        (x, y)
    } else {
        return Err(ApiError::BadRequest(
            "tap requires either {x, y} or {ref}".into(),
        ));
    };

    if long {
        // Long-press: swipe to same point with 1s duration
        adb_shell(&format!("input swipe {x} {y} {x} {y} 1000")).await?;
    } else {
        adb_shell(&format!("input tap {x} {y}")).await?;
    }
    Ok(())
}

async fn handle_swipe(p: SwipeParams) -> Result<(), ApiError> {
    adb_shell(&format!(
        "input swipe {} {} {} {} {}",
        p.x1, p.y1, p.x2, p.y2, p.duration_ms
    ))
    .await?;
    Ok(())
}

async fn handle_pinch(p: PinchParams) -> Result<(), ApiError> {
    // Two concurrent swipes moving symmetrically around the center point.
    // Finger 1: top of center, Finger 2: bottom of center.
    let f1_start_y = p.y - p.start_radius;
    let f1_end_y = p.y - p.end_radius;
    let f2_start_y = p.y + p.start_radius;
    let f2_end_y = p.y + p.end_radius;

    let cmd1 = format!(
        "input swipe {} {} {} {} {}",
        p.x, f1_start_y, p.x, f1_end_y, p.duration_ms
    );
    let cmd2 = format!(
        "input swipe {} {} {} {} {}",
        p.x, f2_start_y, p.x, f2_end_y, p.duration_ms
    );

    let (r1, r2) = tokio::join!(adb_shell(&cmd1), adb_shell(&cmd2));
    r1?;
    r2?;
    Ok(())
}

async fn handle_key(p: KeyParams) -> Result<(), ApiError> {
    let key_lower = p.key.to_lowercase();
    let keycode = match key_lower.as_str() {
        "home" => "3".to_string(),
        "back" => "4".to_string(),
        "call" => "5".to_string(),
        "end_call" | "endcall" => "6".to_string(),
        "power" => "26".to_string(),
        "volume_up" => "24".to_string(),
        "volume_down" => "25".to_string(),
        "menu" => "82".to_string(),
        "enter" => "66".to_string(),
        "delete" | "backspace" => "67".to_string(),
        "tab" => "61".to_string(),
        "recents" | "app_switch" => "187".to_string(),
        "space" => "62".to_string(),
        "escape" | "esc" => "111".to_string(),
        other => {
            if other.chars().all(|c| c.is_ascii_digit()) {
                other.to_string()
            } else {
                return Err(ApiError::BadRequest(format!("unknown key: {other}")));
            }
        }
    };
    adb_shell(&format!("input keyevent {keycode}")).await?;
    Ok(())
}

async fn handle_type(p: TypeParams) -> Result<(), ApiError> {
    // adb shell input text requires escaping: spaces → %s, special chars escaped
    let escaped = p
        .text
        .replace('\\', "\\\\")
        .replace(' ', "%s")
        .replace('&', "\\&")
        .replace('<', "\\<")
        .replace('>', "\\>")
        .replace('(', "\\(")
        .replace(')', "\\)")
        .replace('|', "\\|")
        .replace(';', "\\;")
        .replace('\'', "\\'")
        .replace('"', "\\\"")
        .replace('`', "\\`");
    adb_shell(&format!("input text '{escaped}'")).await?;
    Ok(())
}
