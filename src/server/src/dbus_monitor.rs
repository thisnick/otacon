use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{broadcast, Mutex, RwLock};
use zbus::{
    fdo::{ObjectManagerProxy, PropertiesProxy},
    message::Body,
    Connection, MatchRule, MessageStream,
    zvariant::OwnedValue,
};

use crate::phone::PhoneState;

/// Phone map type: phone_id → PhoneState
type PhoneMap = RwLock<HashMap<String, Arc<PhoneState>>>;

/// Spawn the BlueALSA D-Bus monitor as a background task.
/// Routes events to the correct phone based on the HCI adapter in the D-Bus path.
pub fn spawn_multi_monitor(phones: Arc<PhoneMap>) {
    tokio::spawn(multi_monitor_loop(phones));
}

/// Legacy single-phone spawn (still used when only one phone exists).
pub fn spawn_monitor(
    events_tx: broadcast::Sender<String>,
    active_sinks: Arc<Mutex<HashMap<String, serde_json::Value>>>,
) {
    tokio::spawn(monitor_loop(events_tx, active_sinks));
}

async fn multi_monitor_loop(phones: Arc<PhoneMap>) {
    loop {
        match run_multi_monitor(&phones).await {
            Ok(()) => eprintln!("[dbus] BlueALSA monitor ended, reconnecting..."),
            Err(e) => eprintln!("[dbus] BlueALSA monitor error: {e}, reconnecting in 5s..."),
        }
        // Clear all phone active_sinks on reconnect
        let map = phones.read().await;
        for ps in map.values() {
            ps.active_sinks.lock().await.clear();
        }
        drop(map);
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Find the PhoneState that owns the given HCI adapter.
/// D-Bus path format: /org/bluealsa/hci0/XX_XX_XX_XX_XX_XX/hfphf/source
/// We extract "hci0" and look up which phone is assigned to that adapter.
async fn find_phone_for_path<'a>(
    phones: &'a PhoneMap,
    dbus_path: &str,
) -> Option<Arc<PhoneState>> {
    let hci_dev = parse_hci_device(dbus_path)?;
    // For now, match by adapter_mac or fall back to first phone if only one exists
    let map = phones.read().await;

    // If there's only one phone, route all events to it (backwards compat)
    if map.len() == 1 {
        return map.values().next().cloned();
    }

    // Multi-phone: need to resolve hci device to adapter MAC, then match
    // For now, try to match by phone_bt_mac from the D-Bus path device MAC
    let device_mac = parse_device_mac(dbus_path);
    if let Some(mac) = device_mac {
        for ps in map.values() {
            if let Some(ref bt_mac) = ps.config.phone_bt_mac {
                if bt_mac.eq_ignore_ascii_case(&mac) {
                    return Some(ps.clone());
                }
            }
        }
    }

    // Fallback: try adapter_mac match
    // We'd need to query BlueZ for the adapter MAC of hci_dev, but for now
    // just return None if we can't match
    let _ = hci_dev;
    None
}

async fn run_multi_monitor(
    phones: &Arc<PhoneMap>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let conn = Connection::system().await?;

    // Bootstrap: read all current PCM objects
    bootstrap_multi_state(&conn, phones).await;

    // Subscribe to PropertiesChanged signals from org.bluealsa
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.bluealsa")?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .build();
    let mut stream = MessageStream::for_match_rule(rule, &conn, None).await?;

    eprintln!("[dbus] Multi-phone: listening for BlueALSA PCM state changes");

    use futures::StreamExt;
    while let Some(msg) = stream.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[dbus] Stream error: {e}");
                continue;
            }
        };

        let body: Body = msg.body();
        let Ok((iface, changed)): Result<(String, HashMap<String, OwnedValue>), _> =
            body.deserialize()
        else {
            continue;
        };

        if iface != "org.bluealsa.PCM1" {
            continue;
        }

        let Some(running_val) = changed.get("Running") else {
            continue;
        };
        let Ok(running) = running_val.downcast_ref::<bool>() else {
            continue;
        };

        let path = msg.header().path().map(|p| p.to_string()).unwrap_or_default();
        let profile = parse_profile(&path);
        if profile.is_empty() {
            continue;
        }

        // Route to the correct phone
        let Some(phone) = find_phone_for_path(phones, &path).await else {
            eprintln!("[dbus] No phone matched for path: {path}");
            continue;
        };

        if running {
            let data = query_pcm_properties(&conn, &path, &profile)
                .await
                .unwrap_or_else(|| serde_json::json!({"profile": profile}));

            phone.active_sinks.lock().await.insert(path.clone(), data.clone());

            let event = serde_json::json!({
                "event": "audio.sink.active",
                "data": data,
            });
            let _ = phone.events_tx.send(event.to_string());
            eprintln!("[dbus] [{}] Sink active: {profile} ({path})", phone.config.id);
        } else {
            phone.active_sinks.lock().await.remove(&path);

            let event = serde_json::json!({
                "event": "audio.sink.inactive",
                "data": {"profile": profile},
            });
            let _ = phone.events_tx.send(event.to_string());
            eprintln!("[dbus] [{}] Sink inactive: {profile} ({path})", phone.config.id);
        }
    }

    Ok(())
}

async fn bootstrap_multi_state(
    conn: &Connection,
    phones: &Arc<PhoneMap>,
) {
    let proxy = match ObjectManagerProxy::builder(conn)
        .destination("org.bluealsa")
        .and_then(|b| b.path("/org/bluealsa"))
    {
        Ok(b) => match b.build().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[dbus] Failed to build ObjectManager proxy: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("[dbus] Failed to create ObjectManager proxy: {e}");
            return;
        }
    };

    let objects = match proxy.get_managed_objects().await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[dbus] Failed to get managed objects: {e}");
            return;
        }
    };

    for (path, ifaces) in objects.iter() {
        let path_str = path.to_string();
        let iface_name: zbus::names::InterfaceName =
            match "org.bluealsa.PCM1".try_into() {
                Ok(n) => n,
                Err(_) => continue,
            };
        let Some(props) = ifaces.get(&iface_name) else {
            continue;
        };

        let running = props
            .get("Running")
            .and_then(|v| v.downcast_ref::<bool>().ok())
            .unwrap_or(false);

        if !running {
            continue;
        }

        let profile = parse_profile(&path_str);
        if profile.is_empty() {
            continue;
        }

        if let Some(phone) = find_phone_for_path(phones, &path_str).await {
            let data = pcm_data_from_props(props, &profile);
            phone.active_sinks.lock().await.insert(path_str.clone(), data.clone());

            let event = serde_json::json!({
                "event": "audio.sink.active",
                "data": data,
            });
            let _ = phone.events_tx.send(event.to_string());
            eprintln!("[dbus] Bootstrap: [{}] {profile} active ({path_str})", phone.config.id);
        }
    }
}

// --- Legacy single-phone monitor (unchanged logic) ---

async fn monitor_loop(
    events_tx: broadcast::Sender<String>,
    active_sinks: Arc<Mutex<HashMap<String, serde_json::Value>>>,
) {
    loop {
        match run_monitor(&events_tx, &active_sinks).await {
            Ok(()) => eprintln!("[dbus] BlueALSA monitor ended, reconnecting..."),
            Err(e) => eprintln!("[dbus] BlueALSA monitor error: {e}, reconnecting in 5s..."),
        }
        active_sinks.lock().await.clear();
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn run_monitor(
    events_tx: &broadcast::Sender<String>,
    active_sinks: &Arc<Mutex<HashMap<String, serde_json::Value>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let conn = Connection::system().await?;

    bootstrap_state(&conn, events_tx, active_sinks).await;

    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.bluealsa")?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .build();
    let mut stream = MessageStream::for_match_rule(rule, &conn, None).await?;

    eprintln!("[dbus] Listening for BlueALSA PCM state changes");

    use futures::StreamExt;
    while let Some(msg) = stream.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[dbus] Stream error: {e}");
                continue;
            }
        };

        let body: Body = msg.body();
        let Ok((iface, changed)): Result<(String, HashMap<String, OwnedValue>), _> =
            body.deserialize()
        else {
            continue;
        };

        if iface != "org.bluealsa.PCM1" {
            continue;
        }

        let Some(running_val) = changed.get("Running") else {
            continue;
        };
        let Ok(running) = running_val.downcast_ref::<bool>() else {
            continue;
        };

        let path = msg.header().path().map(|p| p.to_string()).unwrap_or_default();
        let profile = parse_profile(&path);
        if profile.is_empty() {
            continue;
        }

        if running {
            let data = query_pcm_properties(&conn, &path, &profile)
                .await
                .unwrap_or_else(|| serde_json::json!({"profile": profile}));

            active_sinks.lock().await.insert(path.clone(), data.clone());

            let event = serde_json::json!({
                "event": "audio.sink.active",
                "data": data,
            });
            let _ = events_tx.send(event.to_string());
            eprintln!("[dbus] Sink active: {profile} ({path})");
        } else {
            active_sinks.lock().await.remove(&path);

            let event = serde_json::json!({
                "event": "audio.sink.inactive",
                "data": {"profile": profile},
            });
            let _ = events_tx.send(event.to_string());
            eprintln!("[dbus] Sink inactive: {profile} ({path})");
        }
    }

    Ok(())
}

async fn bootstrap_state(
    conn: &Connection,
    events_tx: &broadcast::Sender<String>,
    active_sinks: &Arc<Mutex<HashMap<String, serde_json::Value>>>,
) {
    let proxy = match ObjectManagerProxy::builder(conn)
        .destination("org.bluealsa")
        .and_then(|b| b.path("/org/bluealsa"))
    {
        Ok(b) => match b.build().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[dbus] Failed to build ObjectManager proxy: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("[dbus] Failed to create ObjectManager proxy: {e}");
            return;
        }
    };

    let objects = match proxy.get_managed_objects().await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[dbus] Failed to get managed objects: {e}");
            return;
        }
    };

    let mut sinks = active_sinks.lock().await;
    for (path, ifaces) in objects.iter() {
        let path_str = path.to_string();
        let iface_name: zbus::names::InterfaceName =
            match "org.bluealsa.PCM1".try_into() {
                Ok(n) => n,
                Err(_) => continue,
            };
        let Some(props) = ifaces.get(&iface_name) else {
            continue;
        };

        let running = props
            .get("Running")
            .and_then(|v| v.downcast_ref::<bool>().ok())
            .unwrap_or(false);

        if !running {
            continue;
        }

        let profile = parse_profile(&path_str);
        if profile.is_empty() {
            continue;
        }

        let data = pcm_data_from_props(props, &profile);
        sinks.insert(path_str.clone(), data.clone());

        let event = serde_json::json!({
            "event": "audio.sink.active",
            "data": data,
        });
        let _ = events_tx.send(event.to_string());
        eprintln!("[dbus] Bootstrap: {profile} active ({path_str})");
    }
}

// --- Shared helpers ---

/// Query GetAll on org.bluealsa.PCM1 for a specific path.
async fn query_pcm_properties(
    conn: &Connection,
    path: &str,
    profile: &str,
) -> Option<serde_json::Value> {
    let proxy: PropertiesProxy = PropertiesProxy::builder(conn)
        .destination("org.bluealsa")
        .ok()?
        .path(path)
        .ok()?
        .build()
        .await
        .ok()?;

    let iface_name: zbus::names::InterfaceName = "org.bluealsa.PCM1".try_into().ok()?;
    let props = proxy.get_all(iface_name).await.ok()?;
    Some(pcm_data_from_props(&props, profile))
}

/// Build the event data JSON from PCM properties.
fn pcm_data_from_props(
    props: &HashMap<String, OwnedValue>,
    profile: &str,
) -> serde_json::Value {
    let codec: String = props
        .get("Codec")
        .and_then(|v| {
            let val = v.downcast_ref::<zbus::zvariant::Str>().ok()?;
            Some(val.to_string())
        })
        .unwrap_or_default();
    let sample_rate: u32 = props
        .get("SamplingFrequency")
        .and_then(|v| v.downcast_ref::<u32>().ok())
        .unwrap_or(0);
    let channels: u8 = props
        .get("Channels")
        .and_then(|v| v.downcast_ref::<u8>().ok())
        .unwrap_or(0);

    serde_json::json!({
        "profile": profile,
        "codec": codec,
        "sampleRate": sample_rate,
        "channels": channels,
    })
}

/// Parse BlueALSA profile from D-Bus object path.
/// e.g., "/org/bluealsa/hci0/XX_XX_XX_XX_XX_XX/hfphf/source" → "hfp"
fn parse_profile(path: &str) -> String {
    let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    if parts.len() < 2 {
        return String::new();
    }
    let profile_key = parts[parts.len() - 2];
    match profile_key {
        "hfphf" | "hfpag" => "hfp".into(),
        "a2dpsnk" | "a2dpsrc" => "a2dp".into(),
        _ => String::new(),
    }
}

/// Extract HCI device name from D-Bus path.
/// e.g., "/org/bluealsa/hci0/XX_XX_XX_XX_XX_XX/hfphf/source" → Some("hci0")
fn parse_hci_device(path: &str) -> Option<&str> {
    let parts: Vec<&str> = path.split('/').collect();
    // Path: ["", "org", "bluealsa", "hci0", "XX_XX_XX_XX_XX_XX", ...]
    if parts.len() >= 4 && parts[3].starts_with("hci") {
        Some(parts[3])
    } else {
        None
    }
}

/// Extract device MAC from D-Bus path (underscored format → colon format).
/// e.g., "/org/bluealsa/hci0/AA_BB_CC_DD_EE_FF/..." → Some("AA:BB:CC:DD:EE:FF")
fn parse_device_mac(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    // Path: ["", "org", "bluealsa", "hci0", "AA_BB_CC_DD_EE_FF", ...]
    if parts.len() >= 5 {
        let mac_underscored = parts[4];
        if mac_underscored.len() == 17 && mac_underscored.contains('_') {
            return Some(mac_underscored.replace('_', ":"));
        }
    }
    None
}
