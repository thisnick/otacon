use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{broadcast, Mutex};
use zbus::{
    fdo::{ObjectManagerProxy, PropertiesProxy},
    message::Body,
    Connection, MatchRule, MessageStream,
    zvariant::OwnedValue,
};

/// Spawn the BlueALSA D-Bus monitor as a background task.
pub fn spawn_monitor(
    events_tx: broadcast::Sender<String>,
    active_sinks: Arc<Mutex<HashMap<String, serde_json::Value>>>,
) {
    tokio::spawn(monitor_loop(events_tx, active_sinks));
}

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

    // Bootstrap: read all current PCM objects and their Running state
    bootstrap_state(&conn, events_tx, active_sinks).await;

    // Subscribe to PropertiesChanged signals from org.bluealsa
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

        // PropertiesChanged(interface_name, changed_properties, invalidated)
        let body: Body = msg.body();
        let Ok((iface, changed)): Result<(String, HashMap<String, OwnedValue>), _> =
            body.deserialize()
        else {
            continue;
        };

        if iface != "org.bluealsa.PCM1" {
            continue;
        }

        // Check if Running property changed
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

/// Read all current BlueALSA PCM objects and populate active_sinks.
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
            // BlueALSA Codec is a D-Bus string — try to extract it
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
