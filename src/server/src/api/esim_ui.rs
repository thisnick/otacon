//! eSIM install via the system Settings UI.
//!
//! For Pixel devices (and any non-carrier app), `EuiccManager.downloadSubscription()`
//! fails the carrier privilege check. The only path that works is walking the
//! Settings → Add eSIM → Manual entry flow.
//!
//! This module implements the state machine that drives that UI. See
//! `docs/esim-ui-flow.md` for the full state diagram.

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::adb::adb_shell;
use super::device::get_screen_state;
use super::snapshot::A11yNode;
use crate::phone::PhoneState;

const OVERALL_TIMEOUT: Duration = Duration::from_secs(180);
const POLL_INTERVAL: Duration = Duration::from_millis(700);

#[derive(Debug, Clone, Copy)]
enum UiState {
    /// SIMs landing page (after `am start -a android.settings.MOBILE_NETWORK_LIST`)
    Sims,
    /// "Connect to mobile network" splash
    Connect,
    /// "Confirm your network" carrier picker
    ConfirmNetwork,
    /// "Your camera is unavailable" dialog (we entered the QR flow but camera blocked)
    CameraDialog,
    /// "Scan QR code from carrier" — has a link to troubleshooting
    ScanQr,
    /// "Fix QR code problems" — has "Enter activation code" link
    Troubleshoot,
    /// "Enter activation code" — has EditText + Next button
    EnterCode,
    /// "Set up your <Carrier> eSIM" — has Set up button
    SetUp,
    /// "Setting up <Carrier> eSIM…" — loading
    Loading,
    /// "Activate your eSIM" — terminal success state
    Activate,
    /// Unknown / transitional state — wait briefly and re-poll
    Unknown,
}

/// Run the full Settings UI install flow.
///
/// Returns Ok(carrier_name) on success, Err on failure or timeout.
pub async fn install_via_ui(
    state: Arc<PhoneState>,
    activation_code: &str,
) -> Result<String, String> {
    let serial = state.config.adb_serial.clone();

    // 1. Wake the phone if dozing
    let screen = get_screen_state(&serial).await;
    if screen != "unlocked" {
        eprintln!("[{}] esim-ui: screen state '{}', waking", serial, screen);
        adb_shell(&serial, "input keyevent KEYCODE_WAKEUP").await
            .map_err(|e| format!("wake failed: {e:?}"))?;
        // Dismiss potential lockscreen
        adb_shell(&serial, "input keyevent KEYCODE_MENU").await.ok();
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // 2. Open the Settings entry point
    eprintln!("[{}] esim-ui: opening MOBILE_NETWORK_LIST", serial);
    adb_shell(&serial, "am start -a android.settings.MOBILE_NETWORK_LIST")
        .await
        .map_err(|e| format!("am start failed: {e:?}"))?;

    // 3. State machine loop
    let deadline = Instant::now() + OVERALL_TIMEOUT;
    let mut last_state = UiState::Unknown;
    let mut same_state_iters = 0u32;
    let mut carrier_name = String::new();
    let mut entered_code = false;

    loop {
        if Instant::now() >= deadline {
            return Err(format!("timed out in state {:?}", last_state));
        }

        let nodes = match get_snapshot(&state).await {
            Some(n) => n,
            None => {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };

        let current = detect_state(&nodes);
        if !matches!(current, UiState::Unknown) {
            eprintln!("[{}] esim-ui: state = {:?}", serial, current);
        }

        // Track loop-stuck detection
        if std::mem::discriminant(&current) == std::mem::discriminant(&last_state) {
            same_state_iters += 1;
        } else {
            same_state_iters = 0;
            last_state = current;
        }
        if same_state_iters > 30 {
            return Err(format!("stuck in state {:?} for >20s", current));
        }

        match current {
            UiState::Sims => {
                tap_clickable_with_text(&serial, &nodes, "Add more").await?;
            }
            UiState::Connect => {
                tap_clickable_with_text(&serial, &nodes, "Set up an eSIM").await?;
            }
            UiState::ConfirmNetwork => {
                tap_clickable_with_text(&serial, &nodes, "Use a different network").await?;
            }
            UiState::CameraDialog => {
                tap_clickable_with_text(&serial, &nodes, "OK").await?;
            }
            UiState::ScanQr => {
                // The "Try these troubleshooting steps" text is a clickable
                // span inside a longer TextView, not a clickable node itself.
                // Tap near the bottom of that TextView's bounds (where the
                // link span sits visually).
                tap_link_in_text(&serial, &nodes, "troubleshooting steps").await?;
            }
            UiState::Troubleshoot => {
                tap_clickable_with_text(&serial, &nodes, "Enter activation code").await?;
            }
            UiState::EnterCode => {
                if !entered_code {
                    set_text_by_label(&state, &nodes, "Code", activation_code).await?;
                    entered_code = true;
                    // Wait for Next button to enable
                    tokio::time::sleep(Duration::from_millis(800)).await;
                } else {
                    tap_clickable_with_text(&serial, &nodes, "Next").await?;
                }
            }
            UiState::SetUp => {
                // Capture carrier name from the title "Set up your <X> eSIM"
                if let Some(name) = extract_carrier_from_title(&nodes) {
                    carrier_name = name;
                }
                tap_clickable_with_text(&serial, &nodes, "Set up").await?;
            }
            UiState::Loading => {
                // Just wait
            }
            UiState::Activate => {
                eprintln!("[{}] esim-ui: install complete (carrier={})", serial, carrier_name);
                return Ok(carrier_name);
            }
            UiState::Unknown => {
                // Wait for transitional state to settle
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

// ─────────────────── Snapshot helpers ───────────────────

async fn get_snapshot(state: &PhoneState) -> Option<Vec<A11yNode>> {
    if !state.bridge.is_snapshot_available() {
        return None;
    }
    let json = state.bridge.snapshot_get("/snapshot?format=json").await.ok()?;
    serde_json::from_str(&json).ok()
}

fn tree_contains_text(nodes: &[A11yNode], target: &str) -> bool {
    nodes.iter().any(|n| node_contains_text(n, target))
}

fn node_contains_text(node: &A11yNode, target: &str) -> bool {
    let target_lower = target.to_lowercase();
    let check = |s: &str| s.to_lowercase().contains(&target_lower);
    if let Some(ref t) = node.text { if check(t) { return true; } }
    if let Some(ref d) = node.content_desc { if check(d) { return true; } }
    node.children.iter().any(|c| node_contains_text(c, target))
}

fn detect_state(nodes: &[A11yNode]) -> UiState {
    // Check most specific states first
    if tree_contains_text(nodes, "Activate your eSIM") {
        return UiState::Activate;
    }
    if tree_contains_text(nodes, "Setting up") && tree_contains_text(nodes, "eSIM") {
        return UiState::Loading;
    }
    if tree_contains_text(nodes, "Set up your") && tree_contains_text(nodes, "eSIM") {
        return UiState::SetUp;
    }
    if tree_contains_text(nodes, "Enter activation code") && tree_contains_text(nodes, "from your carrier") {
        return UiState::EnterCode;
    }
    if tree_contains_text(nodes, "Fix QR code problems") {
        return UiState::Troubleshoot;
    }
    if tree_contains_text(nodes, "Scan QR code from carrier") {
        return UiState::ScanQr;
    }
    if tree_contains_text(nodes, "Your camera is unavailable") {
        return UiState::CameraDialog;
    }
    if tree_contains_text(nodes, "Confirm your network") {
        return UiState::ConfirmNetwork;
    }
    if tree_contains_text(nodes, "Connect to mobile network") {
        return UiState::Connect;
    }
    if tree_contains_text(nodes, "SIMs") && tree_contains_text(nodes, "Add more") {
        return UiState::Sims;
    }
    UiState::Unknown
}

// ─────────────────── Action helpers ───────────────────

/// Find the smallest clickable ancestor of a node with the given text and tap
/// it via `input tap` at its bounds center.
async fn tap_clickable_with_text(
    serial: &str,
    nodes: &[A11yNode],
    text: &str,
) -> Result<(), String> {
    for n in nodes {
        if let Some(b) = find_clickable_with_text(n, text) {
            let cx = (b.x1 + b.x2) / 2;
            let cy = (b.y1 + b.y2) / 2;
            adb_shell(serial, &format!("input tap {cx} {cy}"))
                .await
                .map_err(|e| format!("input tap failed: {e:?}"))?;
            eprintln!("[{}] esim-ui: tapped '{}' at ({},{})", serial, text, cx, cy);
            return Ok(());
        }
    }
    Err(format!("no clickable element with text '{text}'"))
}

/// Like `tap_clickable_with_text` but for embedded link spans inside a
/// non-clickable TextView. Taps near the bottom of the matching TextView's
/// bounds (where the link visually sits).
async fn tap_link_in_text(
    serial: &str,
    nodes: &[A11yNode],
    keyword: &str,
) -> Result<(), String> {
    for n in nodes {
        if let Some(b) = find_textview_containing(n, keyword) {
            let cx = (b.x1 + b.x2) / 2;
            // Bottom 25% of bounds where the link span typically sits
            let cy = b.y2 - (b.y2 - b.y1) / 5;
            adb_shell(serial, &format!("input tap {cx} {cy}"))
                .await
                .map_err(|e| format!("input tap failed: {e:?}"))?;
            eprintln!("[{}] esim-ui: tapped link '{}' at ({},{})", serial, keyword, cx, cy);
            return Ok(());
        }
    }
    Err(format!("no TextView containing '{keyword}'"))
}

/// Find an EditText labeled (text or content_desc matches) `label` and set
/// its text via the snapshot server's set_text action.
async fn set_text_by_label(
    state: &PhoneState,
    nodes: &[A11yNode],
    label: &str,
    value: &str,
) -> Result<(), String> {
    let serial = &state.config.adb_serial;
    for n in nodes {
        if let Some(ref_id) = find_edittext_by_label(n, label) {
            let body = serde_json::json!({
                "action": "set_text",
                "ref": ref_id,
                "text": value,
            }).to_string();
            state.bridge.snapshot_post("/action", &body).await
                .map_err(|e| format!("set_text failed: {e:?}"))?;
            eprintln!("[{}] esim-ui: set text on '{}' (ref={})", serial, label, ref_id);
            return Ok(());
        }
    }
    Err(format!("no EditText with label '{label}'"))
}

fn find_clickable_with_text(node: &A11yNode, target: &str) -> Option<super::snapshot::Bounds> {
    // First, find the deepest text-bearing descendant that matches
    // Then walk back up to find the smallest clickable ancestor
    fn matches(n: &A11yNode, target: &str) -> bool {
        let target_lower = target.to_lowercase();
        if let Some(ref t) = n.text {
            if t.trim().to_lowercase() == target_lower { return true; }
        }
        false
    }

    // DFS: returns (clickable_bounds_so_far, found)
    fn walk(n: &A11yNode, target: &str, current_clickable: Option<&super::snapshot::Bounds>)
        -> Option<super::snapshot::Bounds>
    {
        let new_clickable = if n.clickable && n.bounds.is_some() {
            n.bounds.as_ref()
        } else {
            current_clickable
        };
        if matches(n, target) {
            return new_clickable.cloned();
        }
        for c in &n.children {
            if let Some(b) = walk(c, target, new_clickable) {
                return Some(b);
            }
        }
        None
    }
    walk(node, target, None)
}

fn find_textview_containing(node: &A11yNode, keyword: &str) -> Option<super::snapshot::Bounds> {
    let kw = keyword.to_lowercase();
    if let Some(ref t) = node.text {
        if t.to_lowercase().contains(&kw) {
            return node.bounds.clone();
        }
    }
    for c in &node.children {
        if let Some(b) = find_textview_containing(c, keyword) {
            return Some(b);
        }
    }
    None
}

fn find_edittext_by_label(node: &A11yNode, label: &str) -> Option<String> {
    let label_lower = label.to_lowercase();
    let is_edittext = node.class.contains("EditText");
    if is_edittext {
        let matches_label = node.text.as_deref().map_or(false, |t| t.to_lowercase().contains(&label_lower))
            || node.content_desc.as_deref().map_or(false, |d| d.to_lowercase().contains(&label_lower));
        if matches_label {
            return node.ref_id.clone();
        }
    }
    for c in &node.children {
        if let Some(r) = find_edittext_by_label(c, label) {
            return Some(r);
        }
    }
    None
}

fn extract_carrier_from_title(nodes: &[A11yNode]) -> Option<String> {
    fn walk(n: &A11yNode) -> Option<String> {
        if let Some(ref t) = n.text {
            // Title format: "Set up your <Carrier> eSIM"
            if let Some(rest) = t.strip_prefix("Set up your ") {
                if let Some(carrier) = rest.strip_suffix(" eSIM") {
                    return Some(carrier.trim().to_string());
                }
            }
        }
        for c in &n.children {
            if let Some(s) = walk(c) {
                return Some(s);
            }
        }
        None
    }
    nodes.iter().find_map(walk)
}
