//! `ws/voice/control` (one interactive owner) and `ws/voice/monitor`
//! (read-only listeners). See docs/voice-ws.md.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use super::{now_ms, Command, VoiceState, FRAME_MS};
use crate::phone::PhoneState;

pub const PROTOCOL: u32 = 1;
const CLOSE_TAKEN_OVER: u16 = 4001;

/// Events the voice sockets carry (the rest of the phone feed stays on
/// /ws/events).
fn is_voice_event(ty: &str) -> bool {
    ty.starts_with("call.") || ty == "audio.link" || ty == "hfp"
}

fn error(id: Option<&str>, code: &str, message: impl Into<String>) -> Value {
    json!({"type": "error", "id": id, "code": code, "message": message.into()})
}

/// A valid command id: a string of 1–64 characters.
fn command_id(v: &Value) -> Option<String> {
    match v.get("id") {
        Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= 64 => Some(s.clone()),
        _ => None,
    }
}

async fn hello(ps: &PhoneState, voice: &VoiceState, monitor: bool) -> Value {
    let number = ps.phone_number_cache.lock().await.clone();
    let mut audio = json!({
        "format": "pcm_s16le",
        "sampleRate": voice.audio.sample_rate,
        "channels": if monitor { 2 } else { 1 },
        "frameMs": FRAME_MS,
    });
    if monitor {
        audio["channelMap"] = json!(["remote", "local"]);
    }
    json!({
        "type": "hello",
        "protocol": PROTOCOL,
        "phoneId": ps.config.id,
        "number": number,
        "audio": audio,
        "audioLink": voice.link_up(),
        "hfp": voice.hfp_json(),
        "calls": voice.calls(),
        "ts": now_ms(),
    })
}

/// What a socket writer sends, in timeline order.
struct Writer {
    tx: futures::stream::SplitSink<WebSocket, Message>,
    /// Samples (per channel) sent so far
    audio_pos: u64,
    bytes_per_sample: u64,
}

impl Writer {
    async fn json(&mut self, mut v: Value) -> bool {
        if let Some(o) = v.as_object_mut() {
            o.entry("ts").or_insert(json!(now_ms()));
            o.insert("audioPos".into(), json!(self.audio_pos));
        }
        self.tx.send(Message::Text(v.to_string().into())).await.is_ok()
    }

    async fn event(&mut self, raw: &str) -> bool {
        let Ok(v) = serde_json::from_str::<Value>(raw) else { return true };
        let voice = v.get("type").and_then(|t| t.as_str()).map(is_voice_event).unwrap_or(false);
        if !voice {
            return true;
        }
        self.json(v).await
    }

    async fn audio(&mut self, frame: &[u8]) -> bool {
        self.audio_pos += frame.len() as u64 / self.bytes_per_sample;
        self.tx.send(Message::Binary(frame.to_vec().into())).await.is_ok()
    }

    /// Send every event already queued, so an ack never overtakes the
    /// `call.state` events its command caused.
    async fn drain_events(&mut self, events: &mut broadcast::Receiver<String>) -> bool {
        loop {
            match events.try_recv() {
                Ok(raw) => {
                    if !self.event(&raw).await {
                        return false;
                    }
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(_) => return true,
            }
        }
    }
}

// ---- control ----

pub fn control_upgrade(ws: WebSocketUpgrade, ps: Arc<PhoneState>, takeover: bool) -> Response {
    let voice = ps.voice.clone();
    let Ok((id, kick)) = voice.claim_owner(takeover) else {
        return (
            axum::http::StatusCode::CONFLICT,
            axum::Json(json!({
                "error": "voice_control_in_use",
                "message": "another client controls this phone's calls; connect with ?takeover=1 to replace it",
            })),
        )
            .into_response();
    };
    let failed = voice.clone();
    ws.on_failed_upgrade(move |_| failed.release_owner(id))
        .on_upgrade(move |socket| run_control(socket, ps, id, kick))
}

async fn run_control(socket: WebSocket, ps: Arc<PhoneState>, id: u64, kick: tokio::sync::oneshot::Receiver<()>) {
    let voice = ps.voice.clone();
    eprintln!("[{}] voice control {id} connected", ps.config.id);
    voice.client_added(false);
    let (reply_tx, mut reply_rx) = mpsc::unbounded_channel::<Value>();
    voice.set_mark_sink(id, reply_tx.clone());
    let pacer = tokio::spawn(voice.clone().pacer(id));

    // Subscribe before taking the hello snapshot: an event in between is sent
    // twice rather than lost, and events are full state, so that's harmless.
    let mut events = voice.events_tx.subscribe();
    let mut audio = voice.capture_tx.subscribe();
    let hello = hello(&ps, &voice, false).await;

    let (tx, mut rx) = socket.split();
    let mut w = Writer { tx, audio_pos: 0, bytes_per_sample: 2 };

    let mut writer = tokio::spawn(async move {
        let mut kick = kick;
        if !w.json(hello).await {
            return;
        }
        loop {
            tokio::select! {
                biased;
                _ = &mut kick => {
                    let _ = w.tx.send(Message::Close(Some(CloseFrame {
                        code: CLOSE_TAKEN_OVER,
                        reason: "taken over by another client".into(),
                    }))).await;
                    return;
                }
                ev = events.recv() => match ev {
                    Ok(raw) => if !w.event(&raw).await { return },
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                reply = reply_rx.recv() => {
                    let Some(reply) = reply else { return };
                    if !w.drain_events(&mut events).await || !w.json(reply).await {
                        return;
                    }
                }
                frame = audio.recv() => match frame {
                    Ok(f) => if !w.audio(&f).await { return },
                    // A slow client loses the oldest audio, never the socket.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            }
        }
    });

    // Call-control commands run one at a time in the order received; `mark`
    // and `clear` act on the audio queue at once, in order with the audio.
    let inflight: Arc<Mutex<HashSet<String>>> = Default::default();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<(String, Command)>();
    let worker = {
        let voice = voice.clone();
        let inflight = inflight.clone();
        let reply_tx = reply_tx.clone();
        tokio::spawn(async move {
            while let Some((cid, cmd)) = cmd_rx.recv().await {
                let result = voice.execute(cmd).await;
                inflight.lock().unwrap().remove(&cid);
                let msg = match result {
                    Ok(r) => json!({"type": "ack", "id": cid, "result": r}),
                    Err(e) => error(Some(&cid), e.code, e.message),
                };
                if reply_tx.send(msg).is_err() {
                    return;
                }
            }
        })
    };

    let mut overflowing = false;
    let reader = async {
        while let Some(Ok(msg)) = rx.next().await {
            match msg {
                Message::Binary(data) => {
                    if !voice.is_owner(id) {
                        break;
                    }
                    let dropped = voice.uplink.lock().unwrap().push_audio(&data);
                    if dropped > 0 && !overflowing {
                        let _ = reply_tx.send(error(None, "buffer_full", "more than 60 s of audio queued; the excess was dropped"));
                    }
                    overflowing = dropped > 0;
                }
                Message::Text(text) => {
                    let Ok(v) = serde_json::from_str::<Value>(&text) else {
                        let _ = reply_tx.send(error(None, "bad_request", "not JSON"));
                        continue;
                    };
                    handle_text(&voice, &v, &inflight, &cmd_tx, &reply_tx);
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    tokio::select! {
        _ = reader => {}
        _ = &mut writer => {}
    }
    writer.abort();
    worker.abort();
    pacer.abort();
    voice.release_owner(id);
    voice.client_removed(false);
    eprintln!("[{}] voice control {id} disconnected", ps.config.id);
}

fn handle_text(
    voice: &VoiceState,
    v: &Value,
    inflight: &Mutex<HashSet<String>>,
    cmd_tx: &mpsc::UnboundedSender<(String, Command)>,
    reply_tx: &mpsc::UnboundedSender<Value>,
) {
    let Some(ty) = v.get("type").and_then(|t| t.as_str()) else {
        let _ = reply_tx.send(error(None, "bad_request", "missing `type`"));
        return;
    };
    if ty == "mark" {
        match v.get("name").and_then(|n| n.as_str()) {
            Some(name) => voice.uplink.lock().unwrap().push_mark(name.to_string()),
            None => {
                let _ = reply_tx.send(error(None, "bad_request", "`mark` needs a `name`"));
            }
        }
        return;
    }
    let Some(cid) = command_id(v) else {
        let _ = reply_tx.send(error(None, "bad_request", "every command except `mark` needs an `id`: a string of 1-64 characters"));
        return;
    };
    if !inflight.lock().unwrap().insert(cid.clone()) {
        let _ = reply_tx.send(error(Some(&cid), "duplicate_id", "a command with this id is still in flight"));
        return;
    }
    let done = |msg: Value| {
        inflight.lock().unwrap().remove(&cid);
        let _ = reply_tx.send(msg);
    };
    if ty == "clear" {
        let (dropped, marks) = voice.uplink.lock().unwrap().clear();
        for name in marks {
            let _ = reply_tx.send(json!({"type": "mark", "name": name, "cleared": true}));
        }
        let bytes_per_ms = (voice.audio.sample_rate as usize * 2 / 1000).max(1);
        done(json!({"type": "ack", "id": cid, "result": {"droppedMs": dropped / bytes_per_ms}}));
        return;
    }
    match Command::from_json(v) {
        Some(Ok(cmd)) => {
            let _ = cmd_tx.send((cid, cmd));
        }
        Some(Err(msg)) => done(error(Some(&cid), "bad_request", msg)),
        None => done(error(Some(&cid), "bad_request", format!("unknown command `{ty}`"))),
    }
}

// ---- monitor ----

pub fn monitor_upgrade(ws: WebSocketUpgrade, ps: Arc<PhoneState>) -> Response {
    ws.on_upgrade(move |socket| run_monitor(socket, ps))
}

async fn run_monitor(socket: WebSocket, ps: Arc<PhoneState>) {
    let voice = ps.voice.clone();
    voice.client_added(true);
    let mut events = voice.events_tx.subscribe();
    let mut audio = voice.monitor_tx.subscribe();
    let mut hello = hello(&ps, &voice, true).await;
    if let Some(o) = hello.as_object_mut() {
        o.remove("hfp");
    }
    let (tx, mut rx) = socket.split();
    let mut w = Writer { tx, audio_pos: 0, bytes_per_sample: 4 };
    let (reply_tx, mut reply_rx) = mpsc::unbounded_channel::<Value>();

    let mut writer = tokio::spawn(async move {
        if !w.json(hello).await {
            return;
        }
        loop {
            tokio::select! {
                biased;
                ev = events.recv() => match ev {
                    Ok(raw) => if !w.event(&raw).await { return },
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                reply = reply_rx.recv() => {
                    let Some(reply) = reply else { return };
                    if !w.json(reply).await { return }
                }
                frame = audio.recv() => match frame {
                    Ok(f) => if !w.audio(&f).await { return },
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            }
        }
    });

    let reader = async {
        while let Some(Ok(msg)) = rx.next().await {
            match msg {
                Message::Text(text) => {
                    let id = serde_json::from_str::<Value>(&text).ok().and_then(|v| command_id(&v));
                    let _ = reply_tx.send(error(id.as_deref(), "bad_request", "ws/voice/monitor is read-only; use ws/voice/control"));
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    tokio::select! {
        _ = reader => {}
        _ = &mut writer => {}
    }
    writer.abort();
    voice.client_removed(true);
}
