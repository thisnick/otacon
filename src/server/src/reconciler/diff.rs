//! Diff engine: given previous and current observed state, emit the events
//! that would transform previous into current.
//!
//! Pure function — no side effects.

use crate::outbox::events::FleetEvent;
use super::state_file::PersistedState;

/// Compute events needed to reconcile `previous` → `current`.
pub fn compute_events(previous: &PersistedState, current: &PersistedState) -> Vec<FleetEvent> {
    let mut events = Vec::new();

    // Phones: detect new, changed, removed
    for (id, cur_phone) in &current.phones {
        match previous.phones.get(id) {
            Some(prev_phone) => {
                // Status changed
                if prev_phone.status != cur_phone.status {
                    match cur_phone.status.as_str() {
                        "connected" => {
                            events.push(FleetEvent::PhoneConnected {
                                phone_id: cur_phone.phone_id.clone(),
                                adb_serial: cur_phone.adb_serial.clone(),
                                adapter_mac: cur_phone.adapter_mac.clone(),
                                phone_number: cur_phone.phone_number.clone(),
                            });
                        }
                        "disconnected" => {
                            events.push(FleetEvent::PhoneDisconnected {
                                phone_id: cur_phone.phone_id.clone(),
                            });
                        }
                        _ => {}
                    }
                } else if cur_phone.status == "connected"
                    && prev_phone.phone_number != cur_phone.phone_number
                    && cur_phone.phone_number.is_some()
                {
                    // SIM-swap-style change: re-emit PhoneConnected so the
                    // registry picks up the new number. Set-style replay-safe
                    // per CLAUDE.md. Only fires when we observe a non-None
                    // value — matches Q2 conservative policy: don't blow away
                    // a known number based on a transient ADB None reading.
                    events.push(FleetEvent::PhoneConnected {
                        phone_id: cur_phone.phone_id.clone(),
                        adb_serial: cur_phone.adb_serial.clone(),
                        adapter_mac: cur_phone.adapter_mac.clone(),
                        phone_number: cur_phone.phone_number.clone(),
                    });
                }
            }
            None => {
                // New phone
                events.push(FleetEvent::PhoneConnected {
                    phone_id: cur_phone.phone_id.clone(),
                    adb_serial: cur_phone.adb_serial.clone(),
                    adapter_mac: cur_phone.adapter_mac.clone(),
                    phone_number: cur_phone.phone_number.clone(),
                });
            }
        }
    }

    // Phones removed
    for (id, prev_phone) in &previous.phones {
        if !current.phones.contains_key(id) {
            events.push(FleetEvent::PhoneDisconnected {
                phone_id: prev_phone.phone_id.clone(),
            });
        }
    }

    // Dongles: detect new, binding changes, removed
    for (mac, cur_dongle) in &current.dongles {
        match previous.dongles.get(mac) {
            Some(prev_dongle) => {
                // Binding changed
                if prev_dongle.phone_id != cur_dongle.phone_id {
                    if let Some(ref phone_id) = cur_dongle.phone_id {
                        // Look up dongle_id from bt_mac
                        let slug = cur_dongle.bt_mac.replace(':', "").to_lowercase();
                        let dongle_id = format!("dongle-{}", &slug[slug.len().saturating_sub(6)..]);
                        events.push(FleetEvent::DongleBound {
                            dongle_id,
                            phone_id: phone_id.clone(),
                        });
                    } else {
                        let slug = cur_dongle.bt_mac.replace(':', "").to_lowercase();
                        let dongle_id = format!("dongle-{}", &slug[slug.len().saturating_sub(6)..]);
                        events.push(FleetEvent::DongleUnbound { dongle_id });
                    }
                }
            }
            None => {
                // New dongle
                events.push(FleetEvent::DongleDiscovered {
                    bt_mac: cur_dongle.bt_mac.clone(),
                    hci_device: cur_dongle.hci_device.clone(),
                });
            }
        }
    }

    // Dongles removed
    for (mac, _) in &previous.dongles {
        if !current.dongles.contains_key(mac) {
            let slug = mac.replace(':', "").to_lowercase();
            let dongle_id = format!("dongle-{}", &slug[slug.len().saturating_sub(6)..]);
            events.push(FleetEvent::DongleRemoved { dongle_id });
        }
    }

    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::state_file::PersistedPhone;
    use std::collections::HashMap;

    fn phone(id: &str, status: &str, phone_number: Option<&str>) -> PersistedPhone {
        PersistedPhone {
            phone_id: id.into(),
            adb_serial: format!("{id}-serial"),
            adapter_mac: None,
            status: status.into(),
            phone_number: phone_number.map(|s| s.into()),
        }
    }

    fn state_with(phones: Vec<PersistedPhone>) -> PersistedState {
        let mut map = HashMap::new();
        for p in phones {
            map.insert(p.phone_id.clone(), p);
        }
        PersistedState { phones: map, dongles: HashMap::new() }
    }

    #[test]
    fn migration_path_emits_phone_connected_when_number_appears() {
        // Simulates first reconcile after host upgrade: previous state file
        // (loaded from disk) has phone_number=None for an existing connected
        // phone; observe() now reports Some(...) from the populator cache.
        let prev = state_with(vec![phone("phone-1", "connected", None)]);
        let cur = state_with(vec![phone("phone-1", "connected", Some("+15551234567"))]);

        let events = compute_events(&prev, &cur);

        assert_eq!(events.len(), 1, "expected one PhoneConnected event, got {events:?}");
        match &events[0] {
            FleetEvent::PhoneConnected { phone_id, phone_number, .. } => {
                assert_eq!(phone_id, "phone-1");
                assert_eq!(phone_number.as_deref(), Some("+15551234567"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn transient_none_does_not_emit_event() {
        // Q2 conservative policy: an observed None when previously known
        // must NOT emit an event (would clobber the registry's known number).
        let prev = state_with(vec![phone("phone-1", "connected", Some("+15551234567"))]);
        let cur = state_with(vec![phone("phone-1", "connected", None)]);

        let events = compute_events(&prev, &cur);
        assert!(events.is_empty(), "expected no events on Some→None, got {events:?}");
    }

    #[test]
    fn new_phone_carries_phone_number() {
        let prev = state_with(vec![]);
        let cur = state_with(vec![phone("phone-2", "connected", Some("+15559999999"))]);

        let events = compute_events(&prev, &cur);
        assert_eq!(events.len(), 1);
        match &events[0] {
            FleetEvent::PhoneConnected { phone_id, phone_number, .. } => {
                assert_eq!(phone_id, "phone-2");
                assert_eq!(phone_number.as_deref(), Some("+15559999999"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
