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
    SetText(SetTextParams),
    ScrollForward(ScrollParams),
    ScrollBackward(ScrollParams),
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

#[derive(Debug, Deserialize)]
pub struct SetTextParams {
    #[serde(rename = "ref")]
    ref_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
pub struct ScrollParams {
    #[serde(rename = "ref")]
    ref_id: String,
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
        Action::SetText(p) => handle_set_text(state.clone(), p).await?,
        Action::ScrollForward(p) => handle_scroll(state.clone(), p, "scroll_forward").await?,
        Action::ScrollBackward(p) => handle_scroll(state.clone(), p, "scroll_backward").await?,
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
    if let Some(ref ref_id) = p.ref_id {
        let ref_info = resolve_ref(&state, ref_id).await?;
        let (x, y) = bounds_center(&ref_info.bounds);

        if ref_info.in_webview {
            // For WebView elements, scroll into view if off-screen, then coordinate tap
            let screen = get_screen_size().await;
            let mut x = x;
            let mut y = y;
            if let Some((sw, sh)) = screen {
                if x < 0 || y < 0 || x > sw || y > sh {
                    // Try ACTION_FOCUS to scroll element into view
                    if state.bridge.is_snapshot_available() {
                        let body = serde_json::json!({"action": "focus", "ref": ref_id}).to_string();
                        state.bridge.snapshot_post("/action", &body).await.ok();
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        // Re-resolve bounds after scroll
                        if let Ok(new_info) = resolve_ref(&state, ref_id).await {
                            let (nx, ny) = bounds_center(&new_info.bounds);
                            x = nx;
                            y = ny;
                        }
                    }
                }
            }
            if long {
                adb_shell(&format!("input swipe {x} {y} {x} {y} 1000")).await?;
            } else {
                adb_shell(&format!("input tap {x} {y}")).await?;
            }
        } else {
            let action_name = if long { "long_click" } else { "click" };
            if state.bridge.is_snapshot_available() {
                let body = serde_json::json!({"action": action_name, "ref": ref_id}).to_string();
                state.bridge.snapshot_post("/action", &body).await?;
            } else {
                if long {
                    adb_shell(&format!("input swipe {x} {y} {x} {y} 1000")).await?;
                } else {
                    adb_shell(&format!("input tap {x} {y}")).await?;
                }
            }
        }
        return Ok(());
    }

    // Coordinate-based tap: always via ADB input
    if let (Some(x), Some(y)) = (p.x, p.y) {
        if long {
            adb_shell(&format!("input swipe {x} {y} {x} {y} 1000")).await?;
        } else {
            adb_shell(&format!("input tap {x} {y}")).await?;
        }
        return Ok(());
    }

    Err(ApiError::BadRequest(
        "tap requires either {x, y} or {ref}".into(),
    ))
}

/// Info about a ref found in the snapshot tree.
struct RefInfo {
    bounds: (i32, i32, i32, i32),
    in_webview: bool,
}

/// Find bounds and WebView context for a ref_id in the snapshot JSON tree.
fn find_ref_info(node: &serde_json::Value, ref_id: &str, in_webview: bool) -> Option<RefInfo> {
    if let Some(arr) = node.as_array() {
        for child in arr {
            if let Some(r) = find_ref_info(child, ref_id, in_webview) {
                return Some(r);
            }
        }
        return None;
    }
    let is_webview = in_webview
        || node.get("class").and_then(|v| v.as_str()).map_or(false, |c| c.contains("WebView"));
    if node.get("ref_id").and_then(|v| v.as_str()) == Some(ref_id) {
        let bounds = node.get("bounds")?;
        return Some(RefInfo {
            bounds: (
                bounds["x1"].as_i64()? as i32,
                bounds["y1"].as_i64()? as i32,
                bounds["x2"].as_i64()? as i32,
                bounds["y2"].as_i64()? as i32,
            ),
            in_webview: is_webview,
        });
    }
    if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
        for child in children {
            if let Some(r) = find_ref_info(child, ref_id, is_webview) {
                return Some(r);
            }
        }
    }
    None
}

async fn get_screen_size() -> Option<(i32, i32)> {
    let out = adb_shell("wm size").await.ok()?;
    // "Physical size: 1080x2316"
    let size = out.split(':').last()?.trim();
    let mut parts = size.split('x');
    let w = parts.next()?.trim().parse().ok()?;
    let h = parts.next()?.trim().parse().ok()?;
    Some((w, h))
}

fn bounds_center(bounds: &(i32, i32, i32, i32)) -> (i32, i32) {
    ((bounds.0 + bounds.2) / 2, (bounds.1 + bounds.3) / 2)
}

/// Resolve a ref ID to its bounds and WebView context.
async fn resolve_ref(state: &Arc<AppState>, ref_id: &str) -> Result<RefInfo, ApiError> {
    if state.bridge.is_snapshot_available() {
        let snap = state.bridge.snapshot_get("/snapshot?format=json").await?;
        let tree: serde_json::Value = serde_json::from_str(&snap)
            .map_err(|e| ApiError::Adb(format!("parse snapshot: {e}")))?;
        find_ref_info(&tree, ref_id, false)
            .ok_or_else(|| ApiError::NotFound(format!("ref {ref_id} not found")))
    } else {
        let guard = state.snapshot_cache.lock().await;
        let cache = guard
            .as_ref()
            .ok_or_else(|| ApiError::BadRequest("no snapshot taken yet — call GET /api/snapshot first".into()))?;
        if !cache.is_valid() {
            return Err(ApiError::BadRequest(
                "snapshot expired or invalidated — call GET /api/snapshot to refresh".into(),
            ));
        }
        let b = cache
            .ref_bounds
            .get(ref_id)
            .ok_or_else(|| ApiError::NotFound(format!("ref {ref_id} not in current snapshot")))?;
        // ADB fallback doesn't know WebView context — assume not
        Ok(RefInfo {
            bounds: (b.x1, b.y1, b.x2, b.y2),
            in_webview: false,
        })
    }
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

async fn handle_set_text(state: Arc<AppState>, p: SetTextParams) -> Result<(), ApiError> {
    let ref_info = resolve_ref(&state, &p.ref_id).await?;

    // Try performAction(ACTION_SET_TEXT) first — works on native and most WebView EditTexts.
    // Supports full Unicode.
    if state.bridge.is_snapshot_available() {
        let body = serde_json::json!({
            "action": "set_text",
            "ref": p.ref_id,
            "text": p.text,
        })
        .to_string();
        let result = state.bridge.snapshot_post("/action", &body).await?;
        if result.contains("\"ok\":true") || result.contains("\"ok\": true") {
            return Ok(());
        }
        // ACTION_SET_TEXT failed — fall back to clipboard paste
        eprintln!("ACTION_SET_TEXT failed for {}, falling back to clipboard paste", p.ref_id);
    }

    // Fallback: clipboard set → tap to focus → select all → paste.
    // Supports full Unicode via clipboard.
    if state.bridge.is_device_owner_available() {
        let clip_body = serde_json::json!({"text": p.text}).to_string();
        state.bridge.device_post("/clipboard", &clip_body).await?;
        let (x, y) = bounds_center(&ref_info.bounds);
        adb_shell(&format!("input tap {x} {y}")).await?;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        adb_shell("input keyevent 29 --longpress").await.ok(); // Ctrl+A
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        adb_shell("input keyevent 50 --longpress").await.ok(); // Ctrl+V
        return Ok(());
    }

    // Last resort: tap + input text (ASCII only)
    let (x, y) = bounds_center(&ref_info.bounds);
    adb_shell(&format!("input tap {x} {y}")).await?;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let escaped = p.text
        .replace('\\', "\\\\")
        .replace(' ', "%s")
        .replace('&', "\\&")
        .replace('\'', "\\'")
        .replace('"', "\\\"");
    adb_shell(&format!("input text '{escaped}'")).await?;
    Ok(())
}

async fn handle_scroll(state: Arc<AppState>, p: ScrollParams, direction: &str) -> Result<(), ApiError> {
    // Fast path: snapshot server performAction
    if state.bridge.is_snapshot_available() {
        let body = serde_json::json!({"action": direction, "ref": p.ref_id}).to_string();
        state.bridge.snapshot_post("/action", &body).await?;
        return Ok(());
    }

    // ADB fallback: swipe within element bounds
    let guard = state.snapshot_cache.lock().await;
    let cache = guard
        .as_ref()
        .ok_or_else(|| ApiError::BadRequest("no snapshot — call GET /api/snapshot first".into()))?;
    if !cache.is_valid() {
        return Err(ApiError::BadRequest("snapshot expired — refresh first".into()));
    }
    let bounds = cache
        .ref_bounds
        .get(&p.ref_id)
        .ok_or_else(|| ApiError::NotFound(format!("ref {} not found", p.ref_id)))?;
    let cx = (bounds.x1 + bounds.x2) / 2;
    let top = bounds.y1 + (bounds.y2 - bounds.y1) / 4;
    let bot = bounds.y2 - (bounds.y2 - bounds.y1) / 4;
    drop(guard);

    if direction == "scroll_forward" {
        adb_shell(&format!("input swipe {cx} {bot} {cx} {top} 300")).await?;
    } else {
        adb_shell(&format!("input swipe {cx} {top} {cx} {bot} 300")).await?;
    }
    Ok(())
}
