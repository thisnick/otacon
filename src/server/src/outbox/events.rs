//! Event types for the outbox.
//!
//! Every event is a SET operation — replay-safe.

use serde::{Deserialize, Serialize};

/// All event types that flow from host → registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event_type", content = "payload")]
pub enum FleetEvent {
    #[serde(rename = "phone.connected")]
    PhoneConnected {
        phone_id: String,
        adb_serial: String,
        adapter_mac: Option<String>,
    },
    #[serde(rename = "phone.disconnected")]
    PhoneDisconnected { phone_id: String },
    #[serde(rename = "phone.removed")]
    PhoneRemoved { phone_id: String },
    #[serde(rename = "dongle.discovered")]
    DongleDiscovered {
        bt_mac: String,
        hci_device: Option<String>,
    },
    #[serde(rename = "dongle.bound")]
    DongleBound {
        dongle_id: String,
        phone_id: String,
    },
    #[serde(rename = "dongle.unbound")]
    DongleUnbound { dongle_id: String },
    #[serde(rename = "dongle.removed")]
    DongleRemoved { dongle_id: String },
    #[serde(rename = "host.snapshot")]
    HostSnapshot {
        phones: Vec<SnapshotPhone>,
        dongles: Vec<SnapshotDongle>,
    },
    #[serde(rename = "host.online")]
    HostOnline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPhone {
    pub phone_id: String,
    pub adb_serial: String,
    pub adapter_mac: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDongle {
    pub bt_mac: String,
    pub hci_device: Option<String>,
    pub phone_id: Option<String>,
}

impl FleetEvent {
    /// The event_type string for the registry.
    pub fn event_type(&self) -> &'static str {
        match self {
            FleetEvent::PhoneConnected { .. } => "phone.connected",
            FleetEvent::PhoneDisconnected { .. } => "phone.disconnected",
            FleetEvent::PhoneRemoved { .. } => "phone.removed",
            FleetEvent::DongleDiscovered { .. } => "dongle.discovered",
            FleetEvent::DongleBound { .. } => "dongle.bound",
            FleetEvent::DongleUnbound { .. } => "dongle.unbound",
            FleetEvent::DongleRemoved { .. } => "dongle.removed",
            FleetEvent::HostSnapshot { .. } => "host.snapshot",
            FleetEvent::HostOnline => "host.online",
        }
    }

    /// The primary entity ID for this event (if any).
    pub fn entity_id(&self) -> Option<&str> {
        match self {
            FleetEvent::PhoneConnected { phone_id, .. }
            | FleetEvent::PhoneDisconnected { phone_id }
            | FleetEvent::PhoneRemoved { phone_id } => Some(phone_id),
            FleetEvent::DongleDiscovered { bt_mac, .. } => Some(bt_mac),
            FleetEvent::DongleBound { dongle_id, .. }
            | FleetEvent::DongleUnbound { dongle_id }
            | FleetEvent::DongleRemoved { dongle_id } => Some(dongle_id),
            FleetEvent::HostSnapshot { .. } | FleetEvent::HostOnline => None,
        }
    }
}
