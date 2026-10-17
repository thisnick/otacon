//! Calls and call audio for one phone: the `ws/voice/*` protocol
//! (docs/voice-ws.md), the REST call endpoints, and the HFP controller behind
//! both.

pub mod at;
mod audio;
mod controller;
pub mod hfp;
pub mod table;
mod uplink;
pub mod ws;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::{broadcast, mpsc, watch, Notify};

pub use controller::{CmdError, Command};
use table::CallTable;
use uplink::Uplink;

/// Uplink audio is capped at this much queued audio.
const UPLINK_CAP_SECS: usize = 60;
/// Audio frames are 20 ms.
pub const FRAME_MS: u32 = 20;

#[derive(Clone)]
pub struct AudioParams {
    pub sample_rate: u32,
    pub capture_cmd: Vec<String>,
    pub playback_cmd: Vec<String>,
}

impl AudioParams {
    /// Bytes in one mono 20 ms frame.
    pub fn frame_bytes(&self) -> usize {
        (self.sample_rate * FRAME_MS / 1000) as usize * 2
    }
}

#[derive(Default)]
struct HfpStatus {
    connected: bool,
    chld: Vec<String>,
    /// Indicator names from `AT+CIND=?`, index 1 first
    ind_names: Vec<String>,
    call: u32,
    callsetup: u32,
    callheld: u32,
}

/// The controlling socket.
struct Owner {
    id: u64,
    kick: Option<tokio::sync::oneshot::Sender<()>>,
    /// Where mark events for this owner go
    marks: Option<mpsc::UnboundedSender<serde_json::Value>>,
}

pub struct VoiceState {
    pub phone_id: String,
    bt_mac: Option<String>,
    audio: AudioParams,
    /// Phone event feed shared with /ws/events (`{type, ts, ...}` JSON)
    pub events_tx: broadcast::Sender<String>,
    /// Running BlueALSA PCMs of this phone (D-Bus path → event data), for
    /// /ws/events' initial state
    pub active_sinks: Arc<tokio::sync::Mutex<HashMap<String, serde_json::Value>>>,
    shutdown: AtomicBool,
    shutdown_notify: Notify,

    // Call control
    table: Mutex<CallTable>,
    hfp: Mutex<HfpStatus>,
    link: Mutex<Option<hfp::HfpHandle>>,
    cmd_lock: tokio::sync::Mutex<()>,
    refresh_lock: tokio::sync::Mutex<()>,
    kiosk_ringing: AtomicBool,
    /// Poke the HFP loop to re-read calls soon
    poll_now: Notify,
    /// A ringing call's `call.incoming` deadline changed
    deadline_changed: Notify,

    // Audio
    /// Whether the phone should be routing call audio (a call is past ringing)
    audio_expected: watch::Sender<bool>,
    link_up: AtomicBool,
    clients: AtomicU32,
    monitors: AtomicU32,
    clients_changed: Notify,
    /// Mono frames from the phone (the other party)
    capture_tx: broadcast::Sender<Arc<Vec<u8>>>,
    /// Stereo frames for monitors: L remote, R what we play
    monitor_tx: broadcast::Sender<Arc<Vec<u8>>>,
    /// What the pacer played, waiting to be paired with captured frames
    played: Mutex<audio::PlayedBuffer>,
    uplink: Mutex<Uplink>,
    owner: Mutex<Option<Owner>>,
    next_socket_id: AtomicU64,
}

impl VoiceState {
    pub fn new(
        phone_id: String,
        bt_mac: Option<String>,
        audio: AudioParams,
        events_tx: broadcast::Sender<String>,
    ) -> Arc<Self> {
        let cap = audio.sample_rate as usize * 2 * UPLINK_CAP_SECS;
        let played = audio::PlayedBuffer::new(audio.sample_rate);
        let (capture_tx, _) = broadcast::channel(50);
        let (monitor_tx, _) = broadcast::channel(50);
        let (audio_expected, _) = watch::channel(false);
        Arc::new(Self {
            phone_id,
            bt_mac,
            audio,
            events_tx,
            active_sinks: Default::default(),
            shutdown: AtomicBool::new(false),
            shutdown_notify: Notify::new(),
            table: Mutex::new(CallTable::default()),
            hfp: Mutex::new(HfpStatus::default()),
            link: Mutex::new(None),
            cmd_lock: tokio::sync::Mutex::new(()),
            refresh_lock: tokio::sync::Mutex::new(()),
            kiosk_ringing: AtomicBool::new(false),
            poll_now: Notify::new(),
            deadline_changed: Notify::new(),
            audio_expected,
            link_up: AtomicBool::new(false),
            clients: AtomicU32::new(0),
            monitors: AtomicU32::new(0),
            clients_changed: Notify::new(),
            capture_tx,
            monitor_tx,
            played: Mutex::new(played),
            uplink: Mutex::new(Uplink::new(cap)),
            owner: Mutex::new(None),
            next_socket_id: AtomicU64::new(1),
        })
    }

    /// Start the background tasks: the HFP link and BlueALSA watcher
    /// (Bluetooth backend only), the incoming-call announcer and the capture
    /// loop. They all end on `shutdown`.
    fn spawn(self: &Arc<Self>, bluetooth: bool) {
        if bluetooth {
            if self.bt_mac.is_some() {
                self.spawn_until_shutdown(self.clone().hfp_loop());
            }
            self.spawn_until_shutdown(crate::dbus_monitor::monitor_phone(self.clone()));
        }
        self.spawn_until_shutdown(self.clone().announcer());
        self.spawn_until_shutdown(self.clone().capture_loop());
    }

    fn spawn_until_shutdown(self: &Arc<Self>, task: impl std::future::Future<Output = ()> + Send + 'static) {
        let me = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = task => {}
                _ = me.wait_shutdown() => {}
            }
        });
    }

    async fn wait_shutdown(&self) {
        loop {
            let notified = self.shutdown_notify.notified();
            if self.shutdown.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    /// Stop the background tasks (the phone was removed or re-bound). Dropping
    /// the HFP task closes the RFCOMM channel for the replacement.
    fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.shutdown_notify.notify_waiters();
        // The link task ends once no handle is left.
        self.link.lock().unwrap().take();
        if let Some(o) = self.owner.lock().unwrap().as_mut() {
            if let Some(kick) = o.kick.take() {
                let _ = kick.send(());
            }
        }
    }

    pub fn bt_mac(&self) -> Option<&str> {
        self.bt_mac.as_deref()
    }
}

/// One VoiceState per phone (by ADB serial) for the life of the process.
/// PhoneState is rebuilt whenever a phone's config changes, but the HFP
/// channel can only be held once, so the voice side is reused unless the
/// phone's Bluetooth MAC changed.
fn registry() -> &'static Mutex<HashMap<String, Arc<VoiceState>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<VoiceState>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

pub fn for_phone(
    phone_id: &str,
    serial: &str,
    bt_mac: Option<&str>,
    audio: AudioParams,
    bluetooth: bool,
) -> Arc<VoiceState> {
    let mut reg = registry().lock().unwrap();
    if let Some(v) = reg.get(serial) {
        if v.bt_mac.as_deref() == bt_mac && v.phone_id == phone_id {
            return v.clone();
        }
        v.shutdown();
    }
    let (events_tx, _) = broadcast::channel(256);
    let v = VoiceState::new(
        phone_id.to_string(),
        bt_mac.map(String::from),
        audio,
        events_tx,
    );
    v.spawn(bluetooth);
    reg.insert(serial.to_string(), v.clone());
    v
}

/// The phone was deleted.
pub fn forget(serial: &str) {
    if let Some(v) = registry().lock().unwrap().remove(serial) {
        v.shutdown();
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `call_` + 8 hex chars. The starting point is random per process (std's
/// RandomState is seeded from the OS), and stepping by an odd constant mod 2^32
/// never repeats within it.
pub fn new_call_id() -> String {
    use std::hash::BuildHasher;
    static BASE: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let base = *BASE.get_or_init(|| {
        std::collections::hash_map::RandomState::new().hash_one(std::process::id()) as u32
    });
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("call_{:08x}", base.wrapping_add(n.wrapping_mul(0x9E37_79B1)))
}
