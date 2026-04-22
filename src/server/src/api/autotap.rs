//! Generic auto-tap: polls the a11y tree for a button matching one of the
//! target texts and taps it.  Used by eSIM install (tap "Yes") and can be
//! reused for any system dialog that needs autonomous confirmation.

use std::sync::Arc;
use std::time::Duration;

use crate::phone::PhoneState;

use super::adb::adb_shell;
use super::snapshot::{A11yNode, Bounds};

/// Spawn a background task that polls the a11y tree for a clickable button
/// whose text matches one of `targets` (case-insensitive) and taps it.
///
/// If `context_keywords` is non-empty, only taps when one of those keywords
/// is found somewhere in the same a11y tree (case-insensitive substring match
/// on text/content_desc).  This scopes the tap to a specific dialog so we
/// don't accidentally tap a "Yes" button in the foreground app.
///
/// Returns a `JoinHandle` that resolves to `true` if a button was tapped.
/// The task stops after the first successful tap or after `timeout`.
pub fn spawn_auto_tap(
    state: Arc<PhoneState>,
    targets: &'static [&'static str],
    context_keywords: &'static [&'static str],
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

            match find_button(&state, targets, context_keywords).await {
                Some(m) => {
                    // Use `input tap` (real touch event) instead of a11y
                    // ACTION_CLICK — system dialogs (e.g. eSIM confirmation
                    // from the LPA app) often don't honor a11y clicks.
                    let Some(bounds) = m.bounds.as_ref() else {
                        eprintln!(
                            "[{}] auto-tap: button '{}' has no bounds, skipping",
                            serial, m.text
                        );
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    };
                    let cx = (bounds.x1 + bounds.x2) / 2;
                    let cy = (bounds.y1 + bounds.y2) / 2;
                    match adb_shell(&serial, &format!("input tap {cx} {cy}")).await {
                        Ok(_) => {
                            eprintln!(
                                "[{}] auto-tap: tapped '{}' (ref={}) at ({},{}) on iter {}",
                                serial, m.text, m.ref_id, cx, cy, iters
                            );
                            return true;
                        }
                        Err(e) => {
                            eprintln!(
                                "[{}] auto-tap: input tap failed on iter {}: {:?}",
                                serial, iters, e
                            );
                        }
                    }
                }
                None => {
                    if iters == 1 || iters % 5 == 0 {
                        let reason = if context_keywords.is_empty() {
                            "no matching button"
                        } else {
                            "no context+button match"
                        };
                        eprintln!(
                            "[{}] auto-tap: {} on iter {}",
                            serial, reason, iters
                        );
                    }
                }
            }

            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
}

/// Walk the a11y tree and find a clickable button whose text matches one of
/// `targets` (case-insensitive).  If `context_keywords` is non-empty, the
/// keyword must appear somewhere in the tree (in any text/content_desc).
struct ButtonMatch {
    ref_id: String,
    text: String,
    bounds: Option<Bounds>,
}

async fn find_button(
    state: &PhoneState,
    targets: &[&str],
    context_keywords: &[&str],
) -> Option<ButtonMatch> {
    if !state.bridge.is_snapshot_available() {
        return None;
    }
    let json_str = state.bridge.snapshot_get("/snapshot?format=json").await.ok()?;
    let nodes: Vec<A11yNode> = serde_json::from_str(&json_str).ok()?;

    // If context_keywords specified, find buttons ONLY within the top-level
    // window (root node) that contains the context. This prevents tapping a
    // "Yes" button in the underlying activity behind a modal dialog.
    if context_keywords.is_empty() {
        for node in &nodes {
            if let Some(m) = walk_for_button(node, targets) {
                return Some(m);
            }
        }
    } else {
        for node in &nodes {
            if has_context(node, context_keywords) {
                if let Some(m) = walk_for_button(node, targets) {
                    return Some(m);
                }
            }
        }
    }
    None
}

fn has_context(node: &A11yNode, keywords: &[&str]) -> bool {
    let check = |s: &str| {
        let lower = s.to_lowercase();
        keywords.iter().any(|k| lower.contains(*k))
    };
    if let Some(ref t) = node.text { if check(t) { return true; } }
    if let Some(ref d) = node.content_desc { if check(d) { return true; } }
    node.children.iter().any(|c| has_context(c, keywords))
}

fn walk_for_button(node: &A11yNode, targets: &[&str]) -> Option<ButtonMatch> {
    if node.clickable {
        if let Some(ref text) = node.text {
            let lower = text.trim().to_lowercase();
            if targets.iter().any(|t| lower == *t) {
                if let Some(ref_id) = &node.ref_id {
                    return Some(ButtonMatch {
                        ref_id: ref_id.clone(),
                        text: text.clone(),
                        bounds: node.bounds.clone(),
                    });
                }
            }
        }
    }
    for child in &node.children {
        if let Some(m) = walk_for_button(child, targets) {
            return Some(m);
        }
    }
    None
}
