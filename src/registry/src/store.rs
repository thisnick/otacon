use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::{broadcast, mpsc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    pub id: String,
    pub tailscale_ip: Option<String>,
    pub fqdn: Option<String>,
    pub api_port: u16,
    pub status: String,
    pub last_heartbeat: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phone {
    pub id: String,
    pub adb_serial: String,
    pub phone_number: Option<String>,
    pub model: Option<String>,
    pub bt_mac: Option<String>,
    pub imei: Option<String>,
    pub adapter_mac: Option<String>,
    pub host_id: Option<String>,
    pub status: String,
    pub config: PhoneConfig,
    pub connected_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoneConfig {
    pub wifi_enabled: bool,
    pub bluetooth_enabled: bool,
}

impl Default for PhoneConfig {
    fn default() -> Self {
        Self {
            wifi_enabled: false,
            bluetooth_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dongle {
    pub id: String,
    pub bt_mac: String,
    pub host_id: Option<String>,
    pub phone_id: Option<String>,
    pub hci_device: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimCard {
    pub id: String,
    pub iccid: String,
    pub phone_number: Option<String>,
    pub carrier: Option<String>,
    pub phone_id: String,
    pub slot: u8,
    pub is_esim: bool,
    pub is_active: bool,
    pub profile_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: u64,
    pub timestamp: DateTime<Utc>,
    pub event_type: String,
    pub entity_id: Option<String>,
    pub data: Option<serde_json::Value>,
}

/// A config push message sent to a host over its WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigPush {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub phone_id: String,
    pub config: PhoneConfig,
}

/// In-memory registry state backed by JSON files on disk.
pub struct RegistryStore {
    pub hosts: RwLock<HashMap<String, Host>>,
    pub phones: RwLock<HashMap<String, Phone>>,
    pub dongles: RwLock<HashMap<String, Dongle>>,
    pub sims: RwLock<HashMap<String, SimCard>>,
    pub events: RwLock<Vec<Event>>,
    next_event_id: RwLock<u64>,
    data_dir: PathBuf,
    /// Broadcast channel for fleet events (consumed by /ws/fleet/events subscribers)
    pub events_tx: broadcast::Sender<Event>,
    /// Per-host config push channels (host_id → sender). Hosts register on WS connect.
    pub host_config_senders: RwLock<HashMap<String, mpsc::Sender<ConfigPush>>>,
}

impl RegistryStore {
    /// Load store from disk, or create empty if files don't exist.
    pub async fn load(data_dir: &Path) -> Self {
        tokio::fs::create_dir_all(data_dir).await.ok();

        let hosts = load_map(&data_dir.join("hosts.json")).await;
        let phones = load_map(&data_dir.join("phones.json")).await;
        let dongles = load_map(&data_dir.join("dongles.json")).await;
        let sims = load_map(&data_dir.join("sims.json")).await;
        let events = load_events(&data_dir.join("events.jsonl")).await;
        let next_id = events.last().map(|e| e.id + 1).unwrap_or(1);
        let (events_tx, _) = broadcast::channel::<Event>(256);

        Self {
            hosts: RwLock::new(hosts),
            phones: RwLock::new(phones),
            dongles: RwLock::new(dongles),
            sims: RwLock::new(sims),
            events: RwLock::new(events),
            next_event_id: RwLock::new(next_id),
            data_dir: data_dir.to_path_buf(),
            events_tx,
            host_config_senders: RwLock::new(HashMap::new()),
        }
    }

    pub async fn save_hosts(&self) {
        let map = self.hosts.read().await;
        save_map(&self.data_dir.join("hosts.json"), &*map).await;
    }

    pub async fn save_phones(&self) {
        let map = self.phones.read().await;
        save_map(&self.data_dir.join("phones.json"), &*map).await;
    }

    pub async fn save_dongles(&self) {
        let map = self.dongles.read().await;
        save_map(&self.data_dir.join("dongles.json"), &*map).await;
    }

    pub async fn save_sims(&self) {
        let map = self.sims.read().await;
        save_map(&self.data_dir.join("sims.json"), &*map).await;
    }

    /// Append an event to the store and flush to disk.
    pub async fn add_event(
        &self,
        event_type: &str,
        entity_id: Option<String>,
        data: Option<serde_json::Value>,
    ) -> Event {
        let mut next_id = self.next_event_id.write().await;
        let event = Event {
            id: *next_id,
            timestamp: Utc::now(),
            event_type: event_type.to_string(),
            entity_id,
            data,
        };
        *next_id += 1;
        drop(next_id);

        // Append to events vec
        self.events.write().await.push(event.clone());

        // Broadcast to fleet event subscribers (ignore if no receivers)
        let _ = self.events_tx.send(event.clone());

        // Append to events.jsonl
        if let Ok(line) = serde_json::to_string(&event) {
            use tokio::io::AsyncWriteExt;
            let path = self.data_dir.join("events.jsonl");
            if let Ok(mut f) = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .await
            {
                let _ = f.write_all(format!("{line}\n").as_bytes()).await;
            }
        }

        event
    }

    /// Push a config update to a connected host. Returns true if the host was connected.
    pub async fn push_config(&self, host_id: &str, phone_id: &str, config: &PhoneConfig) -> bool {
        let senders = self.host_config_senders.read().await;
        if let Some(tx) = senders.get(host_id) {
            let msg = ConfigPush {
                msg_type: "config_update".into(),
                phone_id: phone_id.into(),
                config: config.clone(),
            };
            tx.send(msg).await.is_ok()
        } else {
            false
        }
    }
}

async fn load_map<V: serde::de::DeserializeOwned>(path: &Path) -> HashMap<String, V> {
    match tokio::fs::read_to_string(path).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

async fn save_map<V: Serialize>(path: &Path, map: &HashMap<String, V>) {
    if let Ok(data) = serde_json::to_string_pretty(map) {
        tokio::fs::write(path, data).await.ok();
    }
}

async fn load_events(path: &Path) -> Vec<Event> {
    match tokio::fs::read_to_string(path).await {
        Ok(data) => data
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}
