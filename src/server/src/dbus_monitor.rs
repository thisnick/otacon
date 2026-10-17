//! Watches BlueALSA's PCMs for one phone over D-Bus.
//!
//! Each running/stopped change becomes `audio.sink.active` /
//! `audio.sink.inactive` on the phone's event feed. (The voice sockets'
//! `audio.link` comes from call audio actually flowing; see voice/audio.rs.)

use std::{collections::HashMap, sync::Arc, time::Duration};
use zbus::{
    fdo::{ObjectManagerProxy, PropertiesProxy},
    message::Body,
    Connection, MatchRule, MessageStream,
    zvariant::OwnedValue,
};

use crate::voice::VoiceState;

/// Run until the phone's VoiceState shuts down.
pub async fn monitor_phone(voice: Arc<VoiceState>) {
    loop {
        match run_monitor(&voice).await {
            Ok(()) => eprintln!("[dbus] [{}] BlueALSA monitor ended, reconnecting...", voice.phone_id),
            Err(e) => eprintln!("[dbus] [{}] BlueALSA monitor error: {e}, reconnecting in 5s...", voice.phone_id),
        }
        voice.active_sinks.lock().await.clear();
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Whether a BlueALSA object path belongs to this phone. Without a known
/// MAC (single-phone setups) every path does.
fn is_ours(voice: &VoiceState, path: &str) -> bool {
    match (voice.bt_mac(), parse_device_mac(path)) {
        (Some(mine), Some(theirs)) => mine.eq_ignore_ascii_case(&theirs),
        (Some(_), None) => false,
        (None, _) => true,
    }
}

async fn update(voice: &VoiceState, conn: &Connection, path: &str, running: bool, props: Option<&HashMap<String, OwnedValue>>) {
    let profile = parse_profile(path);
    if profile.is_empty() {
        return;
    }
    let mut sinks = voice.active_sinks.lock().await;
    if running {
        let data = match props {
            Some(p) => pcm_data_from_props(p, &profile),
            None => query_pcm_properties(conn, path, &profile)
                .await
                .unwrap_or_else(|| serde_json::json!({"profile": profile})),
        };
        sinks.insert(path.to_string(), data.clone());
        emit(voice, "audio.sink.active", data);
        eprintln!("[dbus] [{}] Sink active: {profile} ({path})", voice.phone_id);
    } else {
        if sinks.remove(path).is_none() {
            return;
        }
        emit(voice, "audio.sink.inactive", serde_json::json!({"profile": profile}));
        eprintln!("[dbus] [{}] Sink inactive: {profile} ({path})", voice.phone_id);
    }
}

fn emit(voice: &VoiceState, ty: &str, data: serde_json::Value) {
    let mut v = serde_json::json!({"type": ty, "ts": chrono::Utc::now().timestamp_millis()});
    if let (Some(o), serde_json::Value::Object(d)) = (v.as_object_mut(), data) {
        o.extend(d);
    }
    let _ = voice.events_tx.send(v.to_string());
}

async fn run_monitor(voice: &Arc<VoiceState>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let conn = Connection::system().await?;

    // Subscribe first so a change during the bootstrap isn't missed.
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.bluealsa")?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .build();
    let mut stream = MessageStream::for_match_rule(rule, &conn, None).await?;
    // BlueALSA restarting changes its unique name; start over when it does.
    let owner_rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .add_arg("org.bluealsa")?
        .build();
    let mut owner_changes = MessageStream::for_match_rule(owner_rule, &conn, None).await?;

    bootstrap_state(voice, &conn).await?;
    eprintln!("[dbus] [{}] Listening for BlueALSA PCM state changes", voice.phone_id);

    use futures::StreamExt;
    loop {
        let msg = tokio::select! {
            m = stream.next() => match m {
                Some(m) => m,
                None => break,
            },
            _ = owner_changes.next() => {
                eprintln!("[dbus] [{}] BlueALSA restarted", voice.phone_id);
                break;
            }
        };
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
        let Some(running) = changed.get("Running").and_then(|v| v.downcast_ref::<bool>().ok()) else {
            continue;
        };
        let path = msg.header().path().map(|p| p.to_string()).unwrap_or_default();
        if is_ours(voice, &path) {
            update(voice, &conn, &path, running, None).await;
        }
    }

    Ok(())
}

/// Read the PCMs that are already running. Fails while BlueALSA isn't on the
/// bus yet (the caller retries), since a signal subscription made before the
/// name exists never matches.
async fn bootstrap_state(voice: &Arc<VoiceState>, conn: &Connection) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let proxy = ObjectManagerProxy::builder(conn)
        .destination("org.bluealsa")?
        .path("/org/bluealsa")?
        .build()
        .await?;
    let objects = proxy.get_managed_objects().await?;

    let iface_name = zbus::names::InterfaceName::try_from("org.bluealsa.PCM1")?;
    for (path, ifaces) in objects.iter() {
        let path_str = path.to_string();
        if !is_ours(voice, &path_str) {
            continue;
        }
        let Some(props) = ifaces.get(&iface_name) else {
            continue;
        };
        let running = props
            .get("Running")
            .and_then(|v| v.downcast_ref::<bool>().ok())
            .unwrap_or(false);
        if running {
            update(voice, conn, &path_str, true, Some(props)).await;
        }
    }
    Ok(())
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
/// e.g., "/org/bluealsa/hci0/dev_XX_XX_XX_XX_XX_XX/hfphf/source" → "hfp"
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

/// Extract device MAC from D-Bus path (underscored format → colon format).
/// e.g., "/org/bluealsa/hci0/dev_AA_BB_CC_DD_EE_FF/..." → Some("AA:BB:CC:DD:EE:FF")
fn parse_device_mac(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    // Path: ["", "org", "bluealsa", "hci0", "dev_AA_BB_CC_DD_EE_FF", ...]
    let seg = parts.get(4)?;
    let mac = seg.strip_prefix("dev_").unwrap_or(seg);
    if mac.len() == 17 && mac.contains('_') {
        Some(mac.replace('_', ":"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        let p = "/org/bluealsa/hci2/dev_4C_2E_5E_D2_D6_00/hfphf/sink";
        assert_eq!(parse_profile(p), "hfp");
        assert_eq!(parse_device_mac(p).as_deref(), Some("4C:2E:5E:D2:D6:00"));
        assert_eq!(parse_profile("/org/bluealsa/hci2/dev_4C_2E_5E_D2_D6_00/a2dpsnk/source"), "a2dp");
        assert_eq!(parse_profile("/org/bluealsa/hci2/dev_4C_2E_5E_D2_D6_00/rfcomm"), "");
    }
}
