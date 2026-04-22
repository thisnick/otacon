//! Generic auto-tap: polls the a11y tree for a button matching one of the
//! target texts and taps it.  Used by eSIM install (tap "Yes") and can be
//! reused for any system dialog that needs autonomous confirmation.

use std::sync::Arc;
use std::time::Duration;

use crate::phone::PhoneState;

use super::snapshot::A11yNode;

/// Spawn a background task that polls the a11y tree for a clickable button
/// whose text matches one of `targets` (case-insensitive) and taps it.
///
/// Returns a `JoinHandle` that resolves to `true` if a button was tapped.
/// The task stops after the first successful tap or after `timeout`.
pub fn spawn_auto_tap(
    state: Arc<PhoneState>,
    targets: &'static [&'static str],
    timeout: Duration,
) -> tokio::task::JoinHandle<bool> {
    tokio::spawn(async move {
        let serial = state.config.adb_serial.clone();
        eprintln!(
            "[{}] auto-tap: started, watching for {:?} (snapshot_available={})",
            serial, targets, state.bridge.is_snapshot_available()
        );
        let deadline = tokio::time::Instant::now() + timeout;
        // Brief initial delay — let the dialog appear
        tokio::time::sleep(Duration::from_millis(500)).await;

        let mut iters = 0u32;
        loop {
            if tokio::time::Instant::now() >= deadline {
                eprintln!("[{}] auto-tap: timeout after {} iterations", serial, iters);
                return false;
            }
            iters += 1;

            match find_button(&state, targets).await {
                Some(ref_id) => {
                    let body = serde_json::json!({"action": "click", "ref": ref_id}).to_string();
                    match state.bridge.snapshot_post("/action", &body).await {
                        Ok(_) => {
                            eprintln!(
                                "[{}] auto-tap: tapped dialog button '{}' on iter {}",
                                serial, ref_id, iters
                            );
                            return true;
                        }
                        Err(e) => {
                            eprintln!(
                                "[{}] auto-tap: tap failed on iter {}: {:?}",
                                serial, iters, e
                            );
                        }
                    }
                }
                None => {
                    if iters == 1 || iters % 5 == 0 {
                        eprintln!(
                            "[{}] auto-tap: no matching button on iter {}",
                            serial, iters
                        );
                    }
                }
            }

            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
}

/// Walk the a11y tree and find a clickable button whose text matches one of
/// `targets` (case-insensitive).  Returns the ref ID if found.
async fn find_button(state: &PhoneState, targets: &[&str]) -> Option<String> {
    if !state.bridge.is_snapshot_available() {
        return None;
    }
    let json_str = state.bridge.snapshot_get("/snapshot?format=json").await.ok()?;
    let nodes: Vec<A11yNode> = serde_json::from_str(&json_str).ok()?;
    for node in &nodes {
        if let Some(ref_id) = walk_for_button(node, targets) {
            return Some(ref_id);
        }
    }
    None
}

fn walk_for_button(node: &A11yNode, targets: &[&str]) -> Option<String> {
    if node.clickable {
        if let Some(ref text) = node.text {
            let lower = text.trim().to_lowercase();
            if targets.iter().any(|t| lower == *t) {
                return node.ref_id.clone();
            }
        }
    }
    for child in &node.children {
        if let Some(r) = walk_for_button(child, targets) {
            return Some(r);
        }
    }
    None
}
