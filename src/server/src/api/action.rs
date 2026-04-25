use axum::extract::Json;
use serde::Deserialize;
use std::sync::Arc;
use utoipa::ToSchema;

use super::adb::adb_shell;
use super::{ApiError, ErrorResponse, OkResponse};
use crate::phone::PhoneState;

#[derive(Debug, Deserialize, ToSchema)]
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

#[derive(Debug, Deserialize, ToSchema)]
pub struct TapParams {
    /// X coordinate (if tapping by position)
    x: Option<i32>,
    /// Y coordinate (if tapping by position)
    y: Option<i32>,
    /// Element ref ID (if tapping by ref, e.g. "e5")
    #[serde(rename = "ref")]
    ref_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SwipeParams {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    /// Duration in ms (default 300)
    #[serde(default = "default_swipe_duration")]
    duration_ms: u32,
    /// Pause in ms at end position before releasing (default 0).
    /// Non-zero enables drag mode via sendevent which prevents
    /// fling/momentum — useful for spinners and pickers.
    #[serde(default)]
    pause_ms: u32,
}

fn default_swipe_duration() -> u32 {
    300
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PinchParams {
    /// Center X
    x: i32,
    /// Center Y
    y: i32,
    /// Starting finger distance from center
    start_radius: i32,
    /// Ending finger distance (larger = zoom in)
    end_radius: i32,
    /// Duration in ms (default 500)
    #[serde(default = "default_pinch_duration")]
    duration_ms: u32,
}

fn default_pinch_duration() -> u32 {
    500
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct KeyParams {
    /// Key name (home, back, enter, power, etc.) or raw keycode number
    key: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TypeParams {
    /// Text to type (ASCII only, via ADB input)
    text: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetTextParams {
    /// Element ref ID (must be an EditText)
    #[serde(rename = "ref")]
    ref_id: String,
    /// Text to set (full Unicode support)
    text: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ScrollParams {
    /// Scrollable element ref ID
    #[serde(rename = "ref")]
    ref_id: String,
}

#[utoipa::path(
    post,
    path = "/api/action",
    tag = "Actions",
    operation_id = "performAction",
    request_body = Action,
    responses(
        (status = 200, description = "Action performed successfully", body = OkResponse),
        (status = 400, description = "Bad request", body = ErrorResponse),
        (status = 404, description = "Reference not found", body = ErrorResponse),
    )
)]
pub async fn handler(
    state: Arc<PhoneState>,
    Json(action): Json<Action>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let serial = &state.config.adb_serial;
    match action {
        Action::Tap(p) => handle_tap(state.clone(), p, false).await?,
        Action::LongTap(p) => handle_tap(state.clone(), p, true).await?,
        Action::Swipe(p) => handle_swipe(serial, p).await?,
        Action::Pinch(p) => handle_pinch(serial, p).await?,
        Action::Key(p) => handle_key(serial, p).await?,
        Action::Type(p) => handle_type(serial, p).await?,
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

async fn handle_tap(state: Arc<PhoneState>, p: TapParams, long: bool) -> Result<(), ApiError> {
    let serial = &state.config.adb_serial;
    if let Some(ref ref_id) = p.ref_id {
        let ref_info = resolve_ref(&state, ref_id).await?;
        let (x, y) = bounds_center(&ref_info.bounds);

        if ref_info.in_webview {
            let mut x = x;
            let mut y = y;

            if !ref_info.visible_to_user {
                // Element not visible — focus to scroll into view, re-resolve
                if state.bridge.is_snapshot_available() {
                    let body = serde_json::json!({"action": "focus", "ref": ref_id}).to_string();
                    state.bridge.snapshot_post("/action", &body).await.ok();
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if let Ok(new_info) = resolve_ref(&state, ref_id).await {
                        let (nx, ny) = bounds_center(&new_info.bounds);
                        x = nx;
                        y = ny;
                    }
                }
            }

            if long {
                adb_shell(serial, &format!("input swipe {x} {y} {x} {y} 1000")).await?;
            } else {
                adb_shell(serial, &format!("input tap {x} {y}")).await?;
            }
        } else {
            let action_name = if long { "long_click" } else { "click" };
            if state.bridge.is_snapshot_available() {
                let body = serde_json::json!({"action": action_name, "ref": ref_id}).to_string();
                state.bridge.snapshot_post("/action", &body).await?;
            } else {
                if long {
                    adb_shell(serial, &format!("input swipe {x} {y} {x} {y} 1000")).await?;
                } else {
                    adb_shell(serial, &format!("input tap {x} {y}")).await?;
                }
            }
        }
        return Ok(());
    }

    // Coordinate-based tap: always via ADB input
    if let (Some(x), Some(y)) = (p.x, p.y) {
        if long {
            adb_shell(serial, &format!("input swipe {x} {y} {x} {y} 1000")).await?;
        } else {
            adb_shell(serial, &format!("input tap {x} {y}")).await?;
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
    visible_to_user: bool,
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
            visible_to_user: node.get("visible_to_user").and_then(|v| v.as_bool()).unwrap_or(true),
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

fn bounds_center(bounds: &(i32, i32, i32, i32)) -> (i32, i32) {
    ((bounds.0 + bounds.2) / 2, (bounds.1 + bounds.3) / 2)
}

/// Resolve a ref ID to its bounds and WebView context.
async fn resolve_ref(state: &Arc<PhoneState>, ref_id: &str) -> Result<RefInfo, ApiError> {
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
            visible_to_user: true,
        })
    }
}

async fn handle_swipe(serial: &str, p: SwipeParams) -> Result<(), ApiError> {
    if p.pause_ms > 0 {
        return handle_drag(serial, &p).await;
    }
    adb_shell(serial, &format!(
        "input swipe {} {} {} {} {}",
        p.x1, p.y1, p.x2, p.y2, p.duration_ms
    ))
    .await?;
    Ok(())
}

// --- Drag gesture (sendevent-based swipe with pause before release) ---

struct TouchDeviceInfo {
    device_path: String,
    max_x: i32,
    max_y: i32,
}

/// Discover the touch input device path and coordinate ranges via `getevent -pl`.
async fn discover_touch_device(serial: &str) -> Result<TouchDeviceInfo, ApiError> {
    let output = adb_shell(serial, "getevent -pl").await?;

    let mut current_device: Option<String> = None;
    let mut found_x: Option<i32> = None;
    let mut found_y: Option<i32> = None;

    for line in output.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("add device") {
            // Return previous device if it had both axes
            if let (Some(ref dev), Some(mx), Some(my)) = (&current_device, found_x, found_y) {
                return Ok(TouchDeviceInfo {
                    device_path: dev.clone(),
                    max_x: mx,
                    max_y: my,
                });
            }
            // "add device 1: /dev/input/event0"
            if let Some(pos) = trimmed.find(": /dev/") {
                current_device = Some(trimmed[pos + 2..].trim().to_string());
            }
            found_x = None;
            found_y = None;
        } else if trimmed.contains("ABS_MT_POSITION_X") {
            found_x = parse_getevent_max(trimmed);
        } else if trimmed.contains("ABS_MT_POSITION_Y") {
            found_y = parse_getevent_max(trimmed);
        }
    }

    // Check last device
    if let (Some(dev), Some(mx), Some(my)) = (current_device, found_x, found_y) {
        return Ok(TouchDeviceInfo { device_path: dev, max_x: mx, max_y: my });
    }

    Err(ApiError::Adb("no touch device found via getevent -pl".into()))
}

/// Parse "max NNN" from a getevent -pl ABS line.
fn parse_getevent_max(line: &str) -> Option<i32> {
    for part in line.split(',') {
        let part = part.trim();
        if part.starts_with("max ") {
            return part.split_whitespace().nth(1)?.parse().ok();
        }
    }
    None
}

/// Get the logical screen size (override if set, else physical).
async fn get_screen_size(serial: &str) -> Result<(i32, i32), ApiError> {
    let output = adb_shell(serial, "wm size").await?;
    let mut w = 0i32;
    let mut h = 0i32;
    for line in output.lines() {
        if let Some(colon_pos) = line.find(':') {
            let dims = line[colon_pos + 1..].trim();
            if let Some((ws, hs)) = dims.split_once('x') {
                if let (Ok(ww), Ok(hh)) = (ws.trim().parse::<i32>(), hs.trim().parse::<i32>()) {
                    w = ww;
                    h = hh;
                }
            }
        }
    }
    if w == 0 || h == 0 {
        return Err(ApiError::Adb(format!("failed to parse screen size from: {output}")));
    }
    Ok((w, h))
}

/// Drag gesture via sendevent: moves from start to end, then sends stationary
/// touch events during the pause window to zero out the velocity tracker,
/// preventing fling/momentum on release.
async fn handle_drag(serial: &str, p: &SwipeParams) -> Result<(), ApiError> {
    let touch = discover_touch_device(serial).await?;
    let (screen_w, screen_h) = get_screen_size(serial).await?;

    // Map screen coordinates to touch panel coordinates
    let tx = |sx: i32| -> i64 { sx as i64 * touch.max_x as i64 / screen_w as i64 };
    let ty = |sy: i32| -> i64 { sy as i64 * touch.max_y as i64 / screen_h as i64 };
    let (tx1, ty1) = (tx(p.x1), ty(p.y1));
    let (tx2, ty2) = (tx(p.x2), ty(p.y2));

    let dev = &touch.device_path;
    let steps = 10u32;
    let step_delay = p.duration_ms as f64 / steps as f64 / 1000.0;

    let mut parts: Vec<String> = Vec::new();

    // DOWN
    parts.push(format!("sendevent {dev} 3 57 0"));     // ABS_MT_TRACKING_ID
    parts.push(format!("sendevent {dev} 3 53 {tx1}")); // ABS_MT_POSITION_X
    parts.push(format!("sendevent {dev} 3 54 {ty1}")); // ABS_MT_POSITION_Y
    parts.push(format!("sendevent {dev} 1 330 1"));    // BTN_TOUCH DOWN
    parts.push(format!("sendevent {dev} 0 0 0"));      // SYN_REPORT

    // MOVE: interpolate from start to end
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let x = tx1 + ((tx2 - tx1) as f64 * t) as i64;
        let y = ty1 + ((ty2 - ty1) as f64 * t) as i64;
        parts.push(format!("sleep {step_delay:.4}"));
        parts.push(format!("sendevent {dev} 3 53 {x}"));
        parts.push(format!("sendevent {dev} 3 54 {y}"));
        parts.push(format!("sendevent {dev} 0 0 0"));
    }

    // SETTLE: stationary events to zero out velocity tracker
    let settle_steps = 3u32;
    let settle_delay = p.pause_ms as f64 / settle_steps as f64 / 1000.0;
    for _ in 0..settle_steps {
        parts.push(format!("sleep {settle_delay:.4}"));
        parts.push(format!("sendevent {dev} 3 53 {tx2}"));
        parts.push(format!("sendevent {dev} 3 54 {ty2}"));
        parts.push(format!("sendevent {dev} 0 0 0"));
    }

    // UP
    parts.push(format!("sendevent {dev} 3 57 -1")); // ABS_MT_TRACKING_ID = -1
    parts.push(format!("sendevent {dev} 1 330 0"));  // BTN_TOUCH UP
    parts.push(format!("sendevent {dev} 0 0 0"));    // SYN_REPORT

    let cmd = parts.join(";");
    adb_shell(serial, &cmd).await?;

    Ok(())
}

async fn handle_pinch(serial: &str, p: PinchParams) -> Result<(), ApiError> {
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

    let (r1, r2) = tokio::join!(adb_shell(serial, &cmd1), adb_shell(serial, &cmd2));
    r1?;
    r2?;
    Ok(())
}

async fn handle_key(serial: &str, p: KeyParams) -> Result<(), ApiError> {
    let key_lower = p.key.to_lowercase();

    // Handle modifier combos like "ctrl+v", "ctrl+a", "shift+tab"
    if key_lower.contains('+') {
        let parts: Vec<&str> = key_lower.split('+').collect();
        let keycodes: Result<Vec<String>, _> = parts
            .iter()
            .map(|k| key_to_code(k.trim()))
            .collect();
        let codes = keycodes?;
        let args = codes.join(" ");
        adb_shell(serial, &format!("input keycombination {args}")).await?;
        return Ok(());
    }

    let keycode = key_to_code(&key_lower)?;
    adb_shell(serial, &format!("input keyevent {keycode}")).await?;
    Ok(())
}

fn key_to_code(name: &str) -> Result<String, ApiError> {
    match name {
        "home" => Ok("3".into()),
        "back" => Ok("4".into()),
        "call" => Ok("5".into()),
        "end_call" | "endcall" => Ok("6".into()),
        "power" => Ok("26".into()),
        "volume_up" => Ok("24".into()),
        "volume_down" => Ok("25".into()),
        "menu" => Ok("82".into()),
        "enter" => Ok("66".into()),
        "delete" | "backspace" => Ok("67".into()),
        "tab" => Ok("61".into()),
        "recents" | "app_switch" => Ok("187".into()),
        "space" => Ok("62".into()),
        "escape" | "esc" => Ok("111".into()),
        "ctrl" | "ctrl_left" => Ok("113".into()),
        "ctrl_right" => Ok("114".into()),
        "shift" | "shift_left" => Ok("59".into()),
        "shift_right" => Ok("60".into()),
        "alt" | "alt_left" => Ok("57".into()),
        "alt_right" => Ok("58".into()),
        "meta" | "meta_left" | "cmd" | "cmd_left" | "search" => Ok("117".into()),
        "meta_right" | "cmd_right" => Ok("118".into()),
        "wakeup" | "wake" => Ok("224".into()),
        "sleep" => Ok("223".into()),
        // Letters a-z
        s if s.len() == 1 && s.chars().next().unwrap().is_ascii_lowercase() => {
            Ok((s.chars().next().unwrap() as u32 - 'a' as u32 + 29).to_string())
        }
        // Raw keycodes
        s if s.chars().all(|c| c.is_ascii_digit()) => Ok(s.into()),
        other => Err(ApiError::BadRequest(format!("unknown key: {other}"))),
    }
}

async fn handle_type(serial: &str, p: TypeParams) -> Result<(), ApiError> {
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
    adb_shell(serial, &format!("input text '{escaped}'")).await?;
    Ok(())
}

async fn handle_set_text(state: Arc<PhoneState>, p: SetTextParams) -> Result<(), ApiError> {
    let serial = &state.config.adb_serial;
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
        let encoded = urlencoding::encode(&p.text);
        state.bridge.device_query(serial, &format!("clipboard/set?text={encoded}")).await?;
        let (x, y) = bounds_center(&ref_info.bounds);
        adb_shell(serial, &format!("input tap {x} {y}")).await?;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        adb_shell(serial, "input keyevent 29 --longpress").await.ok(); // Ctrl+A
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        adb_shell(serial, "input keyevent 50 --longpress").await.ok(); // Ctrl+V
        return Ok(());
    }

    // Last resort: tap + input text (ASCII only)
    let (x, y) = bounds_center(&ref_info.bounds);
    adb_shell(serial, &format!("input tap {x} {y}")).await?;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let escaped = p.text
        .replace('\\', "\\\\")
        .replace(' ', "%s")
        .replace('&', "\\&")
        .replace('\'', "\\'")
        .replace('"', "\\\"");
    adb_shell(serial, &format!("input text '{escaped}'")).await?;
    Ok(())
}

async fn handle_scroll(state: Arc<PhoneState>, p: ScrollParams, direction: &str) -> Result<(), ApiError> {
    let serial = &state.config.adb_serial;
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
        adb_shell(serial, &format!("input swipe {cx} {bot} {cx} {top} 300")).await?;
    } else {
        adb_shell(serial, &format!("input swipe {cx} {top} {cx} {bot} 300")).await?;
    }
    Ok(())
}
