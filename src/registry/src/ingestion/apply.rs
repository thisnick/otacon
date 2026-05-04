//! Apply functions for fleet events.
//!
//! Each function is idempotent (SET semantics). Applying the same event
//! N times produces the same result as applying once.

use chrono::Utc;

use crate::store::{Phone, PhoneConfig, Dongle, RegistryStore};

/// Apply a phone.connected event: upsert phone, set status = connected.
///
/// `phone_number` policy: overwrite only when Some — preserves a previously-
/// known number across transient ADB None readings (matches RegisterPhoneBody
/// at api/phones.rs and SIM-removal is handled by the disconnect/reconnect
/// path, not this update).
pub async fn phone_connected(
    store: &RegistryStore,
    host_id: &str,
    phone_id: &str,
    adb_serial: &str,
    adapter_mac: Option<&str>,
    phone_number: Option<&str>,
) {
    let now = Utc::now();
    let mut phones = store.phones.write().await;

    // Find existing by adb_serial or phone_id
    let existing_id = phones.iter()
        .find(|(_, p)| p.adb_serial == adb_serial)
        .map(|(id, _)| id.clone())
        .or_else(|| phones.contains_key(phone_id).then(|| phone_id.to_string()));

    if let Some(id) = existing_id {
        let phone = phones.get_mut(&id).unwrap();
        phone.host_id = Some(host_id.to_string());
        phone.status = "connected".into();
        phone.connected_at = Some(now);
        phone.last_seen_in_heartbeat = Some(now);
        phone.updated_at = now;
        if let Some(mac) = adapter_mac {
            phone.adapter_mac = Some(mac.to_string());
        }
        if let Some(num) = phone_number {
            phone.phone_number = Some(num.to_string());
        }
    } else {
        phones.insert(phone_id.to_string(), Phone {
            id: phone_id.to_string(),
            adb_serial: adb_serial.to_string(),
            phone_number: phone_number.map(|s| s.to_string()),
            model: None,
            bt_mac: None,
            imei: None,
            adapter_mac: adapter_mac.map(|s| s.to_string()),
            host_id: Some(host_id.to_string()),
            status: "connected".into(),
            config: PhoneConfig::default(),
            connected_at: Some(now),
            created_at: now,
            updated_at: now,
            last_seen_in_heartbeat: Some(now),
        });
    }
    drop(phones);
    store.save_phones().await;
}

/// Apply a phone.disconnected event.
pub async fn phone_disconnected(store: &RegistryStore, phone_id: &str) {
    let mut phones = store.phones.write().await;
    if let Some(phone) = phones.get_mut(phone_id) {
        phone.status = "disconnected".into();
        phone.host_id = None;
        phone.updated_at = Utc::now();
    }
    drop(phones);
    store.save_phones().await;
}

/// Apply a phone.removed event.
pub async fn phone_removed(store: &RegistryStore, phone_id: &str) {
    let mut phones = store.phones.write().await;
    let removed = phones.remove(phone_id);
    drop(phones);
    if removed.is_some() {
        store.save_phones().await;
    }
}

/// Apply a dongle.discovered event.
pub async fn dongle_discovered(
    store: &RegistryStore,
    host_id: &str,
    bt_mac: &str,
    hci_device: Option<&str>,
) {
    let now = Utc::now();
    let mut dongles = store.dongles.write().await;

    // Find by bt_mac (case-insensitive)
    let existing_id = dongles.iter()
        .find(|(_, d)| d.bt_mac.eq_ignore_ascii_case(bt_mac))
        .map(|(id, _)| id.clone());

    if let Some(id) = existing_id {
        let dongle = dongles.get_mut(&id).unwrap();
        dongle.host_id = Some(host_id.to_string());
        dongle.status = "online".into();
        if let Some(hci) = hci_device {
            dongle.hci_device = Some(hci.to_string());
        }
    } else {
        let slug = bt_mac.replace(':', "").to_lowercase();
        let dongle_id = format!("dongle-{}", &slug[slug.len().saturating_sub(6)..]);
        dongles.insert(dongle_id.clone(), Dongle {
            id: dongle_id,
            bt_mac: bt_mac.to_string(),
            host_id: Some(host_id.to_string()),
            phone_id: None,
            hci_device: hci_device.map(|s| s.to_string()),
            status: "online".into(),
            created_at: now,
        });
    }
    drop(dongles);
    store.save_dongles().await;
}

/// Apply a dongle.bound event.
pub async fn dongle_bound(store: &RegistryStore, dongle_id: &str, phone_id: &str) {
    let mut dongles = store.dongles.write().await;
    if let Some(dongle) = dongles.get_mut(dongle_id) {
        dongle.phone_id = Some(phone_id.to_string());
    }
    drop(dongles);
    store.save_dongles().await;
}

/// Apply a dongle.unbound event.
pub async fn dongle_unbound(store: &RegistryStore, dongle_id: &str) {
    let mut dongles = store.dongles.write().await;
    if let Some(dongle) = dongles.get_mut(dongle_id) {
        dongle.phone_id = None;
    }
    drop(dongles);
    store.save_dongles().await;
}

/// Apply a dongle.removed event.
pub async fn dongle_removed(store: &RegistryStore, dongle_id: &str) {
    let mut dongles = store.dongles.write().await;
    let removed = dongles.remove(dongle_id);
    drop(dongles);
    if removed.is_some() {
        store.save_dongles().await;
    }
}

/// Apply a host.snapshot event: replace this host's entire view.
/// Phones/dongles not in the snapshot for this host get marked unreachable/offline.
pub async fn host_snapshot(
    store: &RegistryStore,
    host_id: &str,
    snapshot_phones: &[SnapshotPhone],
    snapshot_dongles: &[SnapshotDongle],
) {
    let now = Utc::now();

    // Phones: set status from snapshot, mark missing as unreachable
    let mut phones = store.phones.write().await;
    let snapshot_serials: std::collections::HashSet<&str> = snapshot_phones
        .iter()
        .map(|p| p.adb_serial.as_str())
        .collect();

    // Mark existing phones from this host that aren't in snapshot as unreachable
    for phone in phones.values_mut() {
        if phone.host_id.as_deref() == Some(host_id) {
            if !snapshot_serials.contains(phone.adb_serial.as_str()) {
                phone.status = "unreachable".into();
                phone.updated_at = now;
            }
        }
    }

    // Upsert phones from snapshot. `phone_number` policy: overwrite only
    // when Some (matches phone_connected) — keeps known numbers across
    // transient ADB None readings; SIM removal flows through the
    // disconnect/reconnect path, not snapshot field updates.
    for sp in snapshot_phones {
        let existing_id = phones.iter()
            .find(|(_, p)| p.adb_serial == sp.adb_serial)
            .map(|(id, _)| id.clone());

        if let Some(id) = existing_id {
            let phone = phones.get_mut(&id).unwrap();
            phone.host_id = Some(host_id.to_string());
            phone.status = sp.status.clone();
            phone.last_seen_in_heartbeat = Some(now);
            phone.updated_at = now;
            if sp.adapter_mac.is_some() {
                phone.adapter_mac = sp.adapter_mac.clone();
            }
            if sp.phone_number.is_some() {
                phone.phone_number = sp.phone_number.clone();
            }
        } else {
            phones.insert(sp.phone_id.clone(), Phone {
                id: sp.phone_id.clone(),
                adb_serial: sp.adb_serial.clone(),
                phone_number: sp.phone_number.clone(),
                model: None,
                bt_mac: None,
                imei: None,
                adapter_mac: sp.adapter_mac.clone(),
                host_id: Some(host_id.to_string()),
                status: sp.status.clone(),
                config: PhoneConfig::default(),
                connected_at: Some(now),
                created_at: now,
                updated_at: now,
                last_seen_in_heartbeat: Some(now),
            });
        }
    }
    drop(phones);
    store.save_phones().await;

    // Dongles: similar logic
    let mut dongles = store.dongles.write().await;
    let snapshot_macs: std::collections::HashSet<String> = snapshot_dongles
        .iter()
        .map(|d| d.bt_mac.to_uppercase())
        .collect();

    for dongle in dongles.values_mut() {
        if dongle.host_id.as_deref() == Some(host_id) {
            if !snapshot_macs.contains(&dongle.bt_mac.to_uppercase()) {
                dongle.status = "offline".into();
            }
        }
    }

    for sd in snapshot_dongles {
        let existing_id = dongles.iter()
            .find(|(_, d)| d.bt_mac.eq_ignore_ascii_case(&sd.bt_mac))
            .map(|(id, _)| id.clone());

        if let Some(id) = existing_id {
            let dongle = dongles.get_mut(&id).unwrap();
            dongle.host_id = Some(host_id.to_string());
            dongle.status = "online".into();
            dongle.phone_id = sd.phone_id.clone();
            if sd.hci_device.is_some() {
                dongle.hci_device = sd.hci_device.clone();
            }
        } else {
            let slug = sd.bt_mac.replace(':', "").to_lowercase();
            let dongle_id = format!("dongle-{}", &slug[slug.len().saturating_sub(6)..]);
            dongles.insert(dongle_id.clone(), Dongle {
                id: dongle_id,
                bt_mac: sd.bt_mac.clone(),
                host_id: Some(host_id.to_string()),
                phone_id: sd.phone_id.clone(),
                hci_device: sd.hci_device.clone(),
                status: "online".into(),
                created_at: now,
            });
        }
    }
    drop(dongles);
    store.save_dongles().await;
}

/// Snapshot phone entry (mirrors host's SnapshotPhone).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SnapshotPhone {
    pub phone_id: String,
    pub adb_serial: String,
    pub adapter_mac: Option<String>,
    pub status: String,
    /// Default keeps older host events (in flight before host upgrade)
    /// deserializable.
    #[serde(default)]
    pub phone_number: Option<String>,
}

/// Snapshot dongle entry (mirrors host's SnapshotDongle).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SnapshotDongle {
    pub bt_mac: String,
    pub hci_device: Option<String>,
    pub phone_id: Option<String>,
}
