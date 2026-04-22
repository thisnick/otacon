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
                            });
                        }
                        "disconnected" => {
                            events.push(FleetEvent::PhoneDisconnected {
                                phone_id: cur_phone.phone_id.clone(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            None => {
                // New phone
                events.push(FleetEvent::PhoneConnected {
                    phone_id: cur_phone.phone_id.clone(),
                    adb_serial: cur_phone.adb_serial.clone(),
                    adapter_mac: cur_phone.adapter_mac.clone(),
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
