//! Reconciler: diff observed vs persisted state on each tick, enqueue
//! events into the outbox for anything that changed.
//!
//! Bootstrap: if state files don't exist, send a host.snapshot event
//! (full-state sync) instead of individual events.

pub mod diff;
pub mod observe;
pub mod state_file;

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::AppState;
use crate::outbox::Outbox;
use crate::outbox::events::{FleetEvent, SnapshotPhone, SnapshotDongle};

/// Spawn the reconciler loop.
pub fn spawn(state: Arc<AppState>, outbox: Arc<Outbox>, notify: Arc<Notify>) {
    tokio::spawn(async move {
        reconciler_loop(state, outbox, notify).await;
    });
}

async fn reconciler_loop(state: Arc<AppState>, outbox: Arc<Outbox>, notify: Arc<Notify>) {
    // Check if this is a bootstrap (no state files exist)
    let is_bootstrap = !state_file::exists();

    if is_bootstrap {
        eprintln!("[reconciler] Bootstrap mode — no state files found");
        // Wait a moment for phones to be loaded
        tokio::time::sleep(Duration::from_secs(3)).await;

        let observed = observe::observe(&state).await;

        // Send a host.snapshot event
        let snapshot_phones: Vec<SnapshotPhone> = observed.phones.values().map(|p| {
            SnapshotPhone {
                phone_id: p.phone_id.clone(),
                adb_serial: p.adb_serial.clone(),
                adapter_mac: p.adapter_mac.clone(),
                status: p.status.clone(),
            }
        }).collect();

        let snapshot_dongles: Vec<SnapshotDongle> = observed.dongles.values().map(|d| {
            SnapshotDongle {
                bt_mac: d.bt_mac.clone(),
                hci_device: d.hci_device.clone(),
                phone_id: d.phone_id.clone(),
            }
        }).collect();

        let event = FleetEvent::HostSnapshot {
            phones: snapshot_phones,
            dongles: snapshot_dongles,
        };

        match outbox.enqueue(&event) {
            Ok(seq) => eprintln!("[reconciler] Enqueued bootstrap host.snapshot (seq={seq})"),
            Err(e) => eprintln!("[reconciler] Failed to enqueue bootstrap snapshot: {e}"),
        }

        // Save initial state
        state_file::save(&observed);
        eprintln!("[reconciler] Saved initial state files");
    }

    // Main reconciler loop: 5s tick or signal
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            _ = interval.tick() => {}
            _ = notify.notified() => {}
        }

        let previous = state_file::load();
        let current = observe::observe(&state).await;

        let events = diff::compute_events(&previous, &current);

        if !events.is_empty() {
            eprintln!("[reconciler] Diff produced {} events", events.len());
            for event in &events {
                match outbox.enqueue(event) {
                    Ok(seq) => eprintln!("[reconciler] Enqueued {} (seq={seq})", event.event_type()),
                    Err(e) => eprintln!("[reconciler] Failed to enqueue {}: {e}", event.event_type()),
                }
            }
        }

        // Always save current state (even if no events — state may have other changes)
        state_file::save(&current);
    }
}

/// Create a Notify for triggering immediate reconciliation.
pub fn trigger() -> Arc<Notify> {
    Arc::new(Notify::new())
}
