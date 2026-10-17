//! Call control over HFP: the link supervisor, call-state polling, kiosk
//! caller-ID fallback, and the commands shared by the socket and REST.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::Instant;

use super::at::{normalize_number, parse_chld, parse_cind_names, parse_cind_values, parse_clcc, Unsolicited};
use super::hfp::{self, AtError, HfpHandle};
use super::table::{Call, CallState, CallTable, Change, Direction, NumberSource};
use super::{new_call_id, now_ms, VoiceState};

const AT_TIMEOUT: Duration = Duration::from_secs(5);
/// Phones can take several seconds to list calls while one is being set up;
/// a list whose OK went missing is used after this long (see hfp.rs).
const CLCC_TIMEOUT: Duration = Duration::from_secs(4);
const POLL_IN_CALL: Duration = Duration::from_secs(1);
const POLL_IDLE: Duration = Duration::from_secs(5);
const RETRY_LINK: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub enum Command {
    Dial { to: String },
    Answer { call: Option<String> },
    Reject { call: Option<String> },
    Hangup { call: Option<String> },
    Hold,
    Resume,
    Swap,
    Merge,
    Dtmf { digits: String },
    Status,
}

impl Command {
    pub fn name(&self) -> &'static str {
        match self {
            Command::Dial { .. } => "dial",
            Command::Answer { .. } => "answer",
            Command::Reject { .. } => "reject",
            Command::Hangup { .. } => "hangup",
            Command::Hold => "hold",
            Command::Resume => "resume",
            Command::Swap => "swap",
            Command::Merge => "merge",
            Command::Dtmf { .. } => "dtmf",
            Command::Status => "status",
        }
    }

    /// Parse a socket command (`{"type": ..., ...}`). `None` if `type` isn't a
    /// call-control command.
    pub fn from_json(v: &Value) -> Option<Result<Command, String>> {
        let ty = v.get("type")?.as_str()?;
        let call = || -> Result<Option<String>, String> {
            match v.get("call") {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.clone())),
                Some(_) => Err("`call` must be a string".into()),
            }
        };
        let string = |field: &str| -> Result<String, String> {
            v.get(field)
                .and_then(|x| x.as_str())
                .map(String::from)
                .ok_or_else(|| format!("`{field}` is required"))
        };
        Some(match ty {
            "dial" => string("to").map(|to| Command::Dial { to }),
            "answer" => call().map(|call| Command::Answer { call }),
            "reject" => call().map(|call| Command::Reject { call }),
            "hangup" => call().map(|call| Command::Hangup { call }),
            "hold" => Ok(Command::Hold),
            "resume" => Ok(Command::Resume),
            "swap" => Ok(Command::Swap),
            "merge" => Ok(Command::Merge),
            "dtmf" => string("digits").map(|digits| Command::Dtmf { digits }),
            "status" => Ok(Command::Status),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone)]
pub struct CmdError {
    pub code: &'static str,
    pub message: String,
}

impl CmdError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    fn state(message: impl Into<String>) -> Self {
        Self::new("invalid_state", message)
    }
}

fn at_err(cmd: &str, e: AtError) -> CmdError {
    match e {
        AtError::Phone(msg) => CmdError::new("phone_error", format!("{cmd}: phone answered {msg}")),
        AtError::Timeout => CmdError::new("timeout", format!("{cmd}: no answer from the phone")),
        AtError::Closed => CmdError::new("hfp_unavailable", "the phone's Bluetooth control link is down"),
    }
}

fn ids(calls: &[&Call]) -> Vec<String> {
    calls.iter().map(|c| c.id.clone()).collect()
}

/// What a command waits for after the phone said OK.
enum Wait<T> {
    Done(T),
    Pending,
    Fail(CmdError),
}

impl VoiceState {
    // ---- events ----

    pub(super) fn emit(&self, mut v: Value) {
        if let Some(obj) = v.as_object_mut() {
            obj.insert("ts".into(), json!(now_ms()));
        }
        let _ = self.events_tx.send(v.to_string());
    }

    fn publish(&self, changes: Vec<Change>) {
        for c in changes {
            match c {
                Change::Incoming(call) => {
                    eprintln!("[{}] call.incoming {} {:?}", self.phone_id, call.id, call.number);
                    self.emit(json!({"type": "call.incoming", "call": call}));
                }
                Change::State(call) => {
                    eprintln!("[{}] call.state {} {:?} conf={}", self.phone_id, call.id, call.state, call.conference);
                    self.emit(json!({"type": "call.state", "call": call}));
                }
                Change::Ended { call, reason } => {
                    eprintln!("[{}] call.ended {} {reason}", self.phone_id, call.id);
                    self.emit(json!({"type": "call.ended", "call": call, "reason": reason}));
                }
            }
        }
        let expected = self.table.lock().unwrap().audio_expected();
        self.audio_expected.send_if_modified(|v| {
            let changed = *v != expected;
            *v = expected;
            changed
        });
        self.deadline_changed.notify_one();
    }

    pub fn calls(&self) -> Vec<Call> {
        self.table.lock().unwrap().calls()
    }

    pub fn hfp_connected(&self) -> bool {
        self.hfp.lock().unwrap().connected
    }

    pub fn hfp_json(&self) -> Value {
        let h = self.hfp.lock().unwrap();
        json!({"connected": h.connected, "chld": h.chld})
    }

    fn ringing_hint(&self) -> bool {
        self.hfp.lock().unwrap().callsetup == 1 || self.kiosk_ringing.load(Ordering::Relaxed)
    }

    // ---- HFP link supervisor ----

    pub(super) async fn hfp_loop(self: Arc<Self>) {
        let Some(mac) = self.bt_mac.clone() else { return };
        let mut last_err = String::new();
        loop {
            match self.clone().run_link(&mac).await {
                Ok(()) => last_err.clear(),
                Err(e) => {
                    if e != last_err {
                        eprintln!("[{}] hfp: {e} (retrying every {}s)", self.phone_id, RETRY_LINK.as_secs());
                        last_err = e;
                    }
                }
            }
            tokio::time::sleep(RETRY_LINK).await;
        }
    }

    /// Open the link, run it until it closes. Errors are reasons it couldn't
    /// be opened.
    async fn run_link(self: Arc<Self>, mac: &str) -> Result<(), String> {
        let conn = zbus::Connection::system().await.map_err(|e| format!("D-Bus: {e}"))?;
        let path = hfp::find_rfcomm_path(&conn, mac)
            .await
            .ok_or_else(|| "no RFCOMM channel (phone not connected over HFP)".to_string())?;
        let stream = hfp::open(&conn, &path).await.map_err(|e| format!("open {path}: {e}"))?;
        let (link, mut unsol, task) = hfp::start(stream, self.phone_id.clone());

        if let Err(e) = self.init_link(&link).await {
            task.abort();
            return Err(format!("init: {e:?}"));
        }
        *self.link.lock().unwrap() = Some(link.clone());
        self.hfp.lock().unwrap().connected = true;
        eprintln!("[{}] hfp: connected ({path})", self.phone_id);
        self.emit(json!({"type": "hfp", "connected": true}));

        let mut next_poll = Instant::now();
        loop {
            tokio::select! {
                u = unsol.recv() => match u {
                    Some(u) => {
                        if self.on_unsolicited(u) {
                            next_poll = next_poll.min(Instant::now() + Duration::from_millis(150));
                        }
                    }
                    None => break,
                },
                _ = self.poll_now.notified() => {
                    next_poll = next_poll.min(Instant::now() + Duration::from_millis(100));
                },
                _ = tokio::time::sleep_until(next_poll) => {
                    if let Err(e) = self.refresh().await {
                        if e.code == "hfp_unavailable" {
                            break;
                        }
                    }
                    let busy = !self.table.lock().unwrap().is_empty() || self.ringing_hint();
                    if !busy {
                        self.query_chld(&link).await;
                    }
                    next_poll = Instant::now() + if busy { POLL_IN_CALL } else { POLL_IDLE };
                },
            }
        }

        task.abort();
        *self.link.lock().unwrap() = None;
        {
            let mut h = self.hfp.lock().unwrap();
            h.connected = false;
            h.call = 0;
            h.callsetup = 0;
            h.callheld = 0;
        }
        eprintln!("[{}] hfp: disconnected", self.phone_id);
        self.emit(json!({"type": "hfp", "connected": false}));
        Ok(())
    }

    /// Read the indicator layout and the phone's AT+CHLD options. Only a
    /// closed link fails: BlueALSA may still be setting up the link with the
    /// phone right after it starts, and some answers then never come back
    /// (seen on the Samsung), so missing answers fall back to defaults.
    async fn init_link(&self, link: &HfpHandle) -> Result<(), AtError> {
        async fn ask(link: &HfpHandle, cmd: &str) -> Result<Vec<String>, AtError> {
            match link.at(cmd, AT_TIMEOUT).await {
                Err(AtError::Closed) => Err(AtError::Closed),
                Err(_) => Ok(Vec::new()),
                Ok(lines) => Ok(lines),
            }
        }
        let names = ask(link, "AT+CIND=?")
            .await?
            .iter()
            .map(|l| parse_cind_names(l))
            .find(|n| !n.is_empty())
            // Android's order (every phone in the fleet uses it)
            .unwrap_or_else(|| {
                ["call", "callsetup", "service", "signal", "roam", "battchg", "callheld"]
                    .map(String::from)
                    .to_vec()
            });
        let values = ask(link, "AT+CIND?")
            .await?
            .iter()
            .map(|l| parse_cind_values(l))
            .find(|v| !v.is_empty())
            .unwrap_or_default();
        let chld = ask(link, "AT+CHLD=?")
            .await?
            .iter()
            .map(|l| parse_chld(l))
            .find(|c| !c.is_empty())
            .unwrap_or_default();
        // Ask for caller ID and call-waiting notifications; not every phone
        // passes them through.
        ask(link, "AT+CLIP=1").await?;
        ask(link, "AT+CCWA=1").await?;

        let value = |ind: &str| {
            names.iter().position(|n| n == ind).and_then(|i| values.get(i).copied()).unwrap_or(0)
        };
        let (call, callsetup, callheld) = (value("call"), value("callsetup"), value("callheld"));
        let mut h = self.hfp.lock().unwrap();
        h.ind_names = names;
        h.chld = chld;
        h.call = call;
        h.callsetup = callsetup;
        h.callheld = callheld;
        Ok(())
    }

    /// Handle an unsolicited line. Returns true if calls should be re-read.
    fn on_unsolicited(&self, u: Unsolicited) -> bool {
        match u {
            Unsolicited::Ciev { ind, value } => {
                let name = {
                    let mut h = self.hfp.lock().unwrap();
                    let name = (ind as usize)
                        .checked_sub(1)
                        .and_then(|i| h.ind_names.get(i))
                        .cloned()
                        .unwrap_or_default();
                    match name.as_str() {
                        "call" => h.call = value,
                        "callsetup" => h.callsetup = value,
                        "callheld" => h.callheld = value,
                        _ => {}
                    }
                    name
                };
                match name.as_str() {
                    "callsetup" if value == 1 => {
                        self.ringing(None, NumberSource::Hfp);
                        true
                    }
                    "call" | "callsetup" | "callheld" => true,
                    _ => false,
                }
            }
            Unsolicited::Ring => {
                self.ringing(None, NumberSource::Hfp);
                true
            }
            Unsolicited::Clip { number } | Unsolicited::Ccwa { number } => {
                self.ringing(number, NumberSource::Hfp);
                true
            }
            Unsolicited::Other(_) => false,
        }
    }

    fn ringing(&self, number: Option<String>, source: NumberSource) {
        let changes = self.table.lock().unwrap().ringing(number, source, now_ms(), &mut new_call_id);
        self.publish(changes);
    }

    /// Re-read the calls from the phone and publish what changed.
    pub(super) async fn refresh(&self) -> Result<(), CmdError> {
        let _g = self.refresh_lock.lock().await;
        let link = self.link()?;
        let lines = link.at("AT+CLCC", CLCC_TIMEOUT).await.map_err(|e| at_err("AT+CLCC", e))?;
        let entries: Vec<_> = lines.iter().filter_map(|l| parse_clcc(l)).collect();
        let hint = self.ringing_hint();
        let idle = {
            let h = self.hfp.lock().unwrap();
            h.call == 0 && h.callsetup == 0 && h.callheld == 0
        };
        let changes = self.table.lock().unwrap().reconcile(&entries, hint, idle, now_ms(), &mut new_call_id);
        self.publish(changes);
        Ok(())
    }

    /// Sends `call.incoming` for ringing calls whose number never arrived.
    pub(super) async fn announcer(self: Arc<Self>) {
        loop {
            let next = self.table.lock().unwrap().next_deadline();
            match next {
                Some(at) => {
                    let wait = Duration::from_millis((at - now_ms()).max(0) as u64);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {
                            let changes = self.table.lock().unwrap().tick(now_ms());
                            self.publish(changes);
                        }
                        _ = self.deadline_changed.notified() => {}
                    }
                }
                None => self.deadline_changed.notified().await,
            }
        }
    }

    // ---- kiosk (caller ID fallback, and call state while HFP is down) ----

    /// An event from the kiosk's call watcher (`call.incoming`,
    /// `call.connected`, `call.ended`).
    pub fn kiosk_event(&self, event: &str, data: &Value) {
        let number = data.get("number").and_then(|n| n.as_str()).and_then(|n| normalize_number(n, None));
        let hfp = self.hfp_connected();
        match event {
            "call.incoming" => {
                self.kiosk_ringing.store(true, Ordering::Relaxed);
                self.ringing(number, NumberSource::Kiosk);
            }
            "call.connected" => {
                self.kiosk_ringing.store(false, Ordering::Relaxed);
                if !hfp {
                    let changes = self.table.lock().unwrap().kiosk_offhook(number, now_ms(), &mut new_call_id);
                    self.publish(changes);
                }
            }
            "call.ended" => {
                self.kiosk_ringing.store(false, Ordering::Relaxed);
                if !hfp {
                    let changes = self.table.lock().unwrap().end_all(None);
                    self.publish(changes);
                }
            }
            _ => return,
        }
        self.poll_now.notify_one();
    }

    // ---- commands ----

    fn link(&self) -> Result<HfpHandle, CmdError> {
        self.link
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| CmdError::new("hfp_unavailable", "the phone's Bluetooth control link is down"))
    }

    async fn at(&self, cmd: &str, timeout: Duration) -> Result<Vec<String>, CmdError> {
        self.link()?.at(cmd, timeout).await.map_err(|e| at_err(cmd, e))
    }

    /// Ask for the phone's AT+CHLD options if we don't have them yet: right
    /// after the link comes up the phone may not answer (see init_link).
    async fn query_chld(&self, link: &HfpHandle) {
        if !self.hfp.lock().unwrap().chld.is_empty() {
            return;
        }
        if let Ok(lines) = link.at("AT+CHLD=?", AT_TIMEOUT).await {
            if let Some(chld) = lines.iter().map(|l| parse_chld(l)).find(|c| !c.is_empty()) {
                eprintln!("[{}] hfp: AT+CHLD options {chld:?}", self.phone_id);
                self.hfp.lock().unwrap().chld = chld;
            }
        }
    }

    async fn chld_supports(&self, op: &str) -> Result<(), CmdError> {
        self.query_chld(&self.link()?).await;
        let h = self.hfp.lock().unwrap();
        if h.chld.iter().any(|c| c == op) {
            Ok(())
        } else {
            Err(CmdError::new("unsupported", format!("the phone doesn't support AT+CHLD={op}")))
        }
    }

    /// Re-read calls until `check` is done, fails, or `timeout` passes.
    async fn wait_for<T>(
        &self,
        what: &str,
        timeout: Duration,
        check: impl Fn(&CallTable) -> Wait<T>,
    ) -> Result<T, CmdError> {
        let deadline = Instant::now() + timeout;
        loop {
            // A slow answer from the phone isn't a failure of the command;
            // keep checking until the deadline.
            match self.refresh().await {
                Err(e) if e.code != "timeout" => return Err(e),
                _ => {}
            }
            match check(&self.table.lock().unwrap()) {
                Wait::Done(v) => return Ok(v),
                Wait::Fail(e) => return Err(e),
                Wait::Pending => {}
            }
            if Instant::now() >= deadline {
                return Err(CmdError::new("timeout", format!("the phone accepted the command but {what} didn't happen")));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Run one command. Commands are serialized per phone, whether they come
    /// from a socket or REST. The returned value is `ack.result`.
    pub async fn execute(&self, cmd: Command) -> Result<Value, CmdError> {
        if matches!(cmd, Command::Status) {
            // A snapshot doesn't change anything, so it doesn't wait behind a
            // slow command.
            // A phone that's slow to list its calls (or never does, like one
            // without a SIM) still gets the last known calls.
            if self.hfp_connected() {
                match self.refresh().await {
                    Err(e) if e.code != "timeout" => return Err(e),
                    _ => {}
                }
            }
            return Ok(json!({"calls": self.calls()}));
        }
        let _g = self.cmd_lock.lock().await;
        // Check preconditions against fresh state (or the last known state
        // if the phone is slow to answer).
        match self.refresh().await {
            Err(e) if e.code != "timeout" => return Err(e),
            _ => {}
        }
        match cmd {
            Command::Dial { to } => self.dial(&to).await,
            Command::Answer { call } => self.answer(call).await,
            Command::Reject { call } => self.reject(call).await,
            Command::Hangup { call } => self.hangup(call).await,
            Command::Hold => self.hold().await,
            Command::Resume => self.resume().await,
            Command::Swap => self.swap().await,
            Command::Merge => self.merge().await,
            Command::Dtmf { digits } => self.dtmf(&digits).await,
            Command::Status => unreachable!(),
        }
    }

    async fn dial(&self, to: &str) -> Result<Value, CmdError> {
        let to: String = to.chars().filter(|c| !matches!(c, ' ' | '-' | '(' | ')' | '.')).collect();
        let valid = to.len() >= 2
            && to.len() <= 20
            && to.chars().enumerate().all(|(i, c)| c.is_ascii_digit() || c == '*' || c == '#' || (c == '+' && i == 0));
        if !valid {
            return Err(CmdError::new("bad_request", "`to` must be a phone number (E.164, e.g. +15551234567)"));
        }
        let before: HashSet<String> = {
            let t = self.table.lock().unwrap();
            if !t.with_state(CallState::Dialing).is_empty() || !t.with_state(CallState::Alerting).is_empty() {
                return Err(CmdError::state("a call is already being placed"));
            }
            if !t.with_state(CallState::Active).is_empty() && !t.with_state(CallState::Held).is_empty() {
                return Err(CmdError::state("there are already two calls (one active, one held)"));
            }
            t.calls().into_iter().map(|c| c.id).collect()
        };
        self.at(&format!("ATD{to};"), Duration::from_secs(15)).await?;
        let call = self
            .wait_for("the new call", Duration::from_secs(20), |t| {
                match t.calls().into_iter().find(|c| !before.contains(&c.id) && c.direction == Direction::Outgoing) {
                    Some(c) => Wait::Done(c),
                    None => Wait::Pending,
                }
            })
            .await?;
        Ok(json!({"call": call}))
    }

    /// The ringing call a command is about: the one named, or the only one.
    fn ringing_target(&self, call: Option<String>) -> Result<Call, CmdError> {
        let t = self.table.lock().unwrap();
        match call {
            Some(id) => match t.get(&id) {
                Some(c) if c.state == CallState::Incoming => Ok(c.clone()),
                Some(c) => Err(CmdError::state(format!("call {id} is {:?}, not ringing", c.state).to_lowercase())),
                None => Err(CmdError::state(format!("no call {id}"))),
            },
            None => match t.with_state(CallState::Incoming).as_slice() {
                [c] => Ok((*c).clone()),
                [] => Err(CmdError::state("no ringing call")),
                _ => Err(CmdError::state("more than one ringing call; name one with `call`")),
            },
        }
    }

    async fn answer(&self, call: Option<String>) -> Result<Value, CmdError> {
        let target = self.ringing_target(call)?;
        let waiting = !self.table.lock().unwrap().with_state(CallState::Active).is_empty();
        // A call waiting behind an active call is answered by holding the
        // active one (AT+CHLD=2); ATA is for a call ringing on its own.
        let cmd = if waiting { "AT+CHLD=2" } else { "ATA" };
        let mut last = None;
        // Some phones ignore ATA that arrives before they have finished
        // setting up the ringing call, so it is retried.
        for _ in 0..3 {
            self.at(cmd, AT_TIMEOUT).await?;
            let id = target.id.clone();
            match self
                .wait_for("the answer", Duration::from_millis(2500), |t| match t.get(&id) {
                    Some(c) if c.state == CallState::Active => Wait::Done(c.clone()),
                    Some(_) => Wait::Pending,
                    None => Wait::Fail(CmdError::state("the call ended before it was answered")),
                })
                .await
            {
                Ok(c) => return Ok(json!({"call": c})),
                Err(e) if e.code == "timeout" => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or_else(|| CmdError::new("timeout", "the call wasn't answered")))
    }

    async fn reject(&self, call: Option<String>) -> Result<Value, CmdError> {
        let target = self.ringing_target(call)?;
        self.end_calls(vec![target.id], "rejected", true).await
    }

    /// End calls and wait until they are gone. With `ringing`, a call waiting
    /// behind another call is declined with AT+CHLD=0 instead of AT+CHUP
    /// (which would end the other call).
    async fn end_calls(&self, ids: Vec<String>, reason: &'static str, ringing: bool) -> Result<Value, CmdError> {
        let cmd = {
            let mut t = self.table.lock().unwrap();
            let others_up = t
                .calls()
                .iter()
                .any(|c| !ids.contains(&c.id) && matches!(c.state, CallState::Active | CallState::Held));
            let state = ids.first().and_then(|id| t.get(id)).map(|c| c.state);
            for id in &ids {
                t.mark_local_end(id, reason);
            }
            match state {
                // A call waiting behind another: "user busy" (AT+CHLD=0).
                Some(CallState::Incoming) if ringing && others_up => "AT+CHLD=0",
                Some(CallState::Held) => "AT+CHLD=0",
                _ => "AT+CHUP",
            }
        };
        let result = async {
            self.at(cmd, AT_TIMEOUT).await?;
            self.wait_for("the hang-up", Duration::from_secs(6), |t| {
                if ids.iter().all(|id| t.get(id).is_none()) { Wait::Done(()) } else { Wait::Pending }
            })
            .await
        }
        .await;
        if let Err(e) = result {
            let mut t = self.table.lock().unwrap();
            for id in &ids {
                t.unmark_local_end(id);
            }
            return Err(e);
        }
        Ok(json!({}))
    }

    async fn hangup(&self, call: Option<String>) -> Result<Value, CmdError> {
        let target = {
            let t = self.table.lock().unwrap();
            let pick = |s: CallState| t.with_state(s).first().map(|c| (*c).clone());
            match call {
                Some(id) => t.get(&id).cloned().ok_or_else(|| CmdError::state(format!("no call {id}")))?,
                None => pick(CallState::Active)
                    .or_else(|| pick(CallState::Dialing))
                    .or_else(|| pick(CallState::Alerting))
                    .or_else(|| pick(CallState::Incoming))
                    .or_else(|| pick(CallState::Held))
                    .ok_or_else(|| CmdError::state("no call to hang up"))?,
            }
        };
        if target.state == CallState::Incoming {
            return self.end_calls(vec![target.id], "rejected", true).await;
        }
        // Ending one leg of a merged call ends the whole merged call.
        let ids: Vec<String> = if target.conference {
            let t = self.table.lock().unwrap();
            t.calls()
                .into_iter()
                .filter(|c| c.conference && c.state == target.state)
                .map(|c| c.id)
                .collect()
        } else {
            vec![target.id]
        };
        self.end_calls(ids, "local", false).await
    }

    /// Run an AT+CHLD operation and wait for the expected states.
    async fn chld(
        &self,
        op: &str,
        what: &str,
        check: impl Fn(&CallTable) -> Wait<()>,
    ) -> Result<Value, CmdError> {
        self.chld_supports(op).await?;
        self.at(&format!("AT+CHLD={op}"), AT_TIMEOUT).await?;
        self.wait_for(what, Duration::from_secs(15), check).await?;
        Ok(json!({"calls": self.calls()}))
    }

    fn all_in(t: &CallTable, ids: &[String], state: CallState) -> bool {
        ids.iter().all(|id| t.get(id).map(|c| c.state == state).unwrap_or(false))
    }

    async fn hold(&self) -> Result<Value, CmdError> {
        let active = {
            let t = self.table.lock().unwrap();
            if !t.with_state(CallState::Incoming).is_empty() {
                return Err(CmdError::state("a call is ringing; answer or reject it first"));
            }
            if !t.with_state(CallState::Held).is_empty() {
                return Err(CmdError::state("a call is already on hold; use swap"));
            }
            let a = ids(&t.with_state(CallState::Active));
            if a.is_empty() {
                return Err(CmdError::state("no active call"));
            }
            a
        };
        self.chld("2", "the hold", move |t| {
            if Self::all_in(t, &active, CallState::Held) { Wait::Done(()) } else { Wait::Pending }
        })
        .await
    }

    async fn resume(&self) -> Result<Value, CmdError> {
        let held = {
            let t = self.table.lock().unwrap();
            if !t.with_state(CallState::Incoming).is_empty() {
                return Err(CmdError::state("a call is ringing; answer or reject it first"));
            }
            if !t.with_state(CallState::Active).is_empty() {
                return Err(CmdError::state("a call is active; use swap"));
            }
            let h = ids(&t.with_state(CallState::Held));
            if h.is_empty() {
                return Err(CmdError::state("no held call"));
            }
            h
        };
        self.chld("2", "the resume", move |t| {
            if Self::all_in(t, &held, CallState::Active) { Wait::Done(()) } else { Wait::Pending }
        })
        .await
    }

    async fn swap(&self) -> Result<Value, CmdError> {
        let (active, held) = {
            let t = self.table.lock().unwrap();
            let a = ids(&t.with_state(CallState::Active));
            let h = ids(&t.with_state(CallState::Held));
            if a.is_empty() || h.is_empty() {
                return Err(CmdError::state("swap needs one active and one held call"));
            }
            (a, h)
        };
        self.chld("2", "the swap", move |t| {
            if Self::all_in(t, &active, CallState::Held) && Self::all_in(t, &held, CallState::Active) {
                Wait::Done(())
            } else {
                Wait::Pending
            }
        })
        .await
    }

    async fn merge(&self) -> Result<Value, CmdError> {
        let both = {
            let t = self.table.lock().unwrap();
            let a = ids(&t.with_state(CallState::Active));
            let h = ids(&t.with_state(CallState::Held));
            if a.is_empty() || h.is_empty() {
                return Err(CmdError::state("merge needs one active and one held call"));
            }
            [a, h].concat()
        };
        self.chld("3", "the merge", move |t| {
            let merged = both
                .iter()
                .all(|id| t.get(id).map(|c| c.state == CallState::Active && c.conference).unwrap_or(false));
            if merged { Wait::Done(()) } else { Wait::Pending }
        })
        .await
    }

    async fn dtmf(&self, digits: &str) -> Result<Value, CmdError> {
        let digits = digits.to_ascii_uppercase();
        let valid = !digits.is_empty()
            && digits.len() <= 100
            && digits.chars().all(|c| c.is_ascii_digit() || matches!(c, '*' | '#' | 'A'..='D' | 'W'));
        if !valid {
            return Err(CmdError::new("bad_request", "`digits` may contain 0-9 * # A-D and w (wait 500 ms)"));
        }
        if self.table.lock().unwrap().with_state(CallState::Active).is_empty() {
            return Err(CmdError::state("no active call"));
        }
        for c in digits.chars() {
            if c == 'W' {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            self.at(&format!("AT+VTS={c}"), AT_TIMEOUT).await?;
            // The phone sends a fixed-length tone per digit; leave a gap so
            // consecutive digits register as separate presses.
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        Ok(json!({"digits": digits.replace('W', "w")}))
    }
}
