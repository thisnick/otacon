//! Atomic read/write of state snapshots for reconciler diffing.
//!
//! State files live at /data/otacon/state/{phones,dongles}.json.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Persisted phone state (for diffing).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersistedPhone {
    pub phone_id: String,
    pub adb_serial: String,
    pub adapter_mac: Option<String>,
    pub status: String,
    /// Default keeps older state files (written before this field existed)
    /// deserializable; first reconcile after upgrade will populate it.
    #[serde(default)]
    pub phone_number: Option<String>,
}

/// Persisted dongle state (for diffing).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersistedDongle {
    pub bt_mac: String,
    pub hci_device: Option<String>,
    pub phone_id: Option<String>,
}

/// All persisted state.
#[derive(Debug, Clone, Default)]
pub struct PersistedState {
    pub phones: HashMap<String, PersistedPhone>,
    pub dongles: HashMap<String, PersistedDongle>,
}

const STATE_DIR: &str = "/data/otacon/state";

fn phones_path() -> PathBuf {
    Path::new(STATE_DIR).join("phones.json")
}

fn dongles_path() -> PathBuf {
    Path::new(STATE_DIR).join("dongles.json")
}

/// Load persisted state from disk. Returns default (empty) if files don't exist.
pub fn load() -> PersistedState {
    let phones = load_json::<HashMap<String, PersistedPhone>>(&phones_path());
    let dongles = load_json::<HashMap<String, PersistedDongle>>(&dongles_path());
    PersistedState { phones, dongles }
}

/// Check if state directory exists (for bootstrap detection).
pub fn exists() -> bool {
    Path::new(STATE_DIR).join("phones.json").exists()
}

/// Atomically save state to disk.
pub fn save(state: &PersistedState) {
    std::fs::create_dir_all(STATE_DIR).ok();
    save_json(&phones_path(), &state.phones);
    save_json(&dongles_path(), &state.dongles);
}

fn load_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    match std::fs::read_to_string(path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

fn save_json<T: Serialize>(path: &Path, data: &T) {
    let json = match serde_json::to_string_pretty(data) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[reconciler] Failed to serialize state: {e}");
            return;
        }
    };
    // Atomic write: write to temp, then rename
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, &json).is_ok() {
        if std::fs::rename(&tmp, path).is_err() {
            std::fs::remove_file(&tmp).ok();
        }
    }
}
