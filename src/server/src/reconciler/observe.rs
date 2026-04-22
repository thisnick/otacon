//! Observe current state from in-memory phone/dongle state.

use std::collections::HashMap;

use crate::AppState;
use super::state_file::{PersistedPhone, PersistedState};

/// Build a PersistedState from the current in-memory AppState.
pub async fn observe(state: &AppState) -> PersistedState {
    let phones = state.phones.read().await;
    let mut persisted_phones = HashMap::new();
    for (id, ps) in phones.iter() {
        persisted_phones.insert(id.clone(), PersistedPhone {
            phone_id: id.clone(),
            adb_serial: ps.config.adb_serial.clone(),
            adapter_mac: ps.config.adapter_mac.clone(),
            status: "connected".into(), // if it's in the phone map, it's connected
        });
    }
    drop(phones);

    // Dongles: we don't have a live dongle map in AppState yet.
    // The fleet client tracks dongle_ids but not full state.
    // For now, dongles come from the fleet client's cached list.
    // This will be enriched when we have a proper dongle state map.
    let persisted_dongles = HashMap::new();

    PersistedState {
        phones: persisted_phones,
        dongles: persisted_dongles,
    }
}
