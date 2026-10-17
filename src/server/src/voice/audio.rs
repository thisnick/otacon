//! Call audio: capture from the phone, the uplink pacer, and the stereo mix
//! for monitors.
//!
//! Capture and playback only run while a voice client is connected and a
//! call is past ringing, so the phone's Bluetooth audio device isn't held
//! open between calls.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};

use super::VoiceState;

/// How far monitors' played channel runs behind the pacer: about the time
/// audio spends in aplay before the phone gets it, and room for the two
/// sides' frames to arrive unevenly.
const PLAYED_DELAY_MS: usize = 100;
/// More buffered than this means capture fell behind; drop back to the delay.
const PLAYED_MAX_MS: usize = 400;
/// Silence written when playback starts, so a late tick doesn't underrun.
const PREFILL_FRAMES: usize = 3;

impl VoiceState {
    fn audio_wanted(&self) -> bool {
        self.clients.load(Ordering::Relaxed) > 0 && *self.audio_expected.borrow()
    }

    pub(super) fn client_added(&self, monitor: bool) {
        self.clients.fetch_add(1, Ordering::Relaxed);
        if monitor {
            self.monitors.fetch_add(1, Ordering::Relaxed);
        }
        self.clients_changed.notify_waiters();
    }

    pub(super) fn client_removed(&self, monitor: bool) {
        self.clients.fetch_sub(1, Ordering::Relaxed);
        if monitor {
            self.monitors.fetch_sub(1, Ordering::Relaxed);
        }
        self.clients_changed.notify_waiters();
    }

    /// Wait until capture/playback should run (or a second passes).
    async fn wait_audio_change(&self) {
        let mut rx = self.audio_expected.subscribe();
        tokio::select! {
            _ = rx.changed() => {}
            _ = self.clients_changed.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }

    pub fn set_link_up(&self, up: bool) {
        if self.link_up.swap(up, Ordering::Relaxed) != up {
            self.emit(json!({"type": "audio.link", "up": up}));
        }
    }

    pub fn link_up(&self) -> bool {
        self.link_up.load(Ordering::Relaxed)
    }

    /// Capture the phone's call audio in 20 ms frames for control and monitor
    /// sockets.
    pub(super) async fn capture_loop(self: Arc<Self>) {
        let frame = self.audio.frame_bytes();
        loop {
            if !self.audio_wanted() {
                self.wait_audio_change().await;
                continue;
            }
            let cmd = &self.audio.capture_cmd;
            let mut child = match Command::new(&cmd[0])
                .args(&cmd[1..])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[{}] capture: {e}", self.phone_id);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            eprintln!("[{}] capture started", self.phone_id);
            self.played.lock().unwrap().clear();
            let mut out = child.stdout.take().unwrap();
            let mut buf = vec![0u8; frame];
            loop {
                if !self.audio_wanted() {
                    break;
                }
                // The audio link is up while the phone is sending us call
                // audio: frames flowing, not just the device being open.
                match tokio::time::timeout(Duration::from_millis(500), out.read_exact(&mut buf)).await {
                    Ok(Ok(_)) => {
                        self.set_link_up(true);
                        self.captured(&buf);
                    }
                    Ok(Err(_)) => break,
                    Err(_) => self.set_link_up(false), // nothing yet (link opening) or stalled
                }
            }
            self.set_link_up(false);
            let _ = child.kill().await;
            eprintln!("[{}] capture stopped", self.phone_id);
            if self.audio_wanted() {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    }

    fn captured(&self, mono: &[u8]) {
        let _ = self.capture_tx.send(Arc::new(mono.to_vec()));
        if self.monitors.load(Ordering::Relaxed) == 0 {
            return;
        }
        let right = self.played.lock().unwrap().take(mono.len());
        let mut stereo = Vec::with_capacity(mono.len() * 2);
        for (l, r) in mono.chunks_exact(2).zip(right.chunks_exact(2)) {
            stereo.extend_from_slice(&[l[0], l[1], r[0], r[1]]);
        }
        let _ = self.monitor_tx.send(Arc::new(stereo));
    }

    fn record_played(&self, pcm: &[u8]) {
        if self.monitors.load(Ordering::Relaxed) == 0 {
            return;
        }
        self.played.lock().unwrap().push(pcm);
    }

    /// Play the uplink queue into the phone in 20 ms steps while socket
    /// `owner` is connected. Marks are reported to the owner as they are
    /// reached, whether or not a call is up to hear the audio.
    pub(super) async fn pacer(self: Arc<Self>, owner: u64) {
        let frame = self.audio.frame_bytes();
        let silence = vec![0u8; frame];
        let mut player: Option<(Child, ChildStdin)> = None;
        let mut retry_at = tokio::time::Instant::now();
        let mut tick = tokio::time::interval(Duration::from_millis(super::FRAME_MS as u64));
        loop {
            tick.tick().await;
            let f = self.uplink.lock().unwrap().next_frame(frame);
            if !f.marks.is_empty() {
                let sink = self.owner.lock().unwrap().as_ref().filter(|o| o.id == owner).and_then(|o| o.marks.clone());
                let Some(sink) = sink else { return };
                for name in f.marks {
                    let _ = sink.send(json!({"type": "mark", "name": name, "cleared": false}));
                }
            }

            if self.audio_wanted() {
                if player.is_none() && tokio::time::Instant::now() >= retry_at {
                    player = self.start_player(&silence).await;
                    if player.is_none() {
                        retry_at = tokio::time::Instant::now() + Duration::from_secs(1);
                    }
                }
            } else if let Some((mut child, _)) = player.take() {
                let _ = child.kill().await;
            }

            if let Some((_, stdin)) = player.as_mut() {
                let ok = matches!(
                    tokio::time::timeout(Duration::from_millis(200), stdin.write_all(&f.pcm)).await,
                    Ok(Ok(()))
                );
                if !ok {
                    eprintln!("[{}] playback stalled, restarting", self.phone_id);
                    if let Some((mut child, _)) = player.take() {
                        let _ = child.kill().await;
                    }
                    retry_at = tokio::time::Instant::now() + Duration::from_millis(300);
                }
            }
            self.record_played(&f.pcm);
        }
    }

    async fn start_player(&self, silence: &[u8]) -> Option<(Child, ChildStdin)> {
        let cmd = &self.audio.playback_cmd;
        let mut child = match Command::new(&cmd[0])
            .args(&cmd[1..])
            .stdin(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[{}] playback: {e}", self.phone_id);
                return None;
            }
        };
        let mut stdin = child.stdin.take()?;
        shrink_pipe(&stdin);
        for _ in 0..PREFILL_FRAMES {
            if stdin.write_all(silence).await.is_err() {
                return None;
            }
        }
        eprintln!("[{}] playback started", self.phone_id);
        Some((child, stdin))
    }

    // ---- uplink ownership ----

    /// Claim the controlling socket. With `takeover`, the current owner is
    /// told to close; otherwise a second claim fails.
    pub(super) fn claim_owner(&self, takeover: bool) -> Result<(u64, tokio::sync::oneshot::Receiver<()>), ()> {
        let mut slot = self.owner.lock().unwrap();
        if let Some(cur) = slot.as_mut() {
            if !takeover {
                return Err(());
            }
            if let Some(kick) = cur.kick.take() {
                let _ = kick.send(());
            }
        }
        let id = self.next_socket_id.fetch_add(1, Ordering::Relaxed);
        let (kick, rx) = tokio::sync::oneshot::channel();
        *slot = Some(super::Owner { id, kick: Some(kick), marks: None });
        drop(slot);
        // Audio queued by the previous owner is not ours to play.
        self.uplink.lock().unwrap().clear();
        Ok((id, rx))
    }

    pub(super) fn set_mark_sink(&self, owner: u64, sink: tokio::sync::mpsc::UnboundedSender<Value>) {
        if let Some(o) = self.owner.lock().unwrap().as_mut().filter(|o| o.id == owner) {
            o.marks = Some(sink);
        }
    }

    pub(super) fn release_owner(&self, owner: u64) {
        let mut slot = self.owner.lock().unwrap();
        if slot.as_ref().map(|o| o.id) == Some(owner) {
            *slot = None;
            drop(slot);
            self.uplink.lock().unwrap().clear();
        }
    }

    pub(super) fn is_owner(&self, owner: u64) -> bool {
        self.owner.lock().unwrap().as_ref().map(|o| o.id) == Some(owner)
    }
}

/// What the pacer played, waiting to be paired with captured frames for
/// monitors. Played and captured frames come from separate clocks and don't
/// arrive in step, so this is a small jitter buffer: pairing starts once
/// `delay` is buffered, and after running dry it waits for `delay` again
/// rather than splitting frames with silence.
pub(super) struct PlayedBuffer {
    pcm: VecDeque<u8>,
    primed: bool,
    delay: usize,
    max: usize,
}

impl PlayedBuffer {
    pub fn new(sample_rate: u32) -> Self {
        let bytes = |ms: usize| sample_rate as usize * 2 * ms / 1000;
        Self { pcm: VecDeque::new(), primed: false, delay: bytes(PLAYED_DELAY_MS), max: bytes(PLAYED_MAX_MS) }
    }

    pub fn clear(&mut self) {
        self.pcm.clear();
        self.primed = false;
    }

    pub fn push(&mut self, pcm: &[u8]) {
        self.pcm.extend(pcm.iter().copied());
        if self.pcm.len() > self.max {
            let excess = self.pcm.len() - self.delay;
            self.pcm.drain(..excess);
        }
    }

    /// Played audio for the next `n` captured bytes (silence while priming).
    pub fn take(&mut self, n: usize) -> Vec<u8> {
        if !self.primed && self.pcm.len() >= self.delay {
            self.primed = true;
        }
        if !self.primed || self.pcm.len() < n {
            self.primed = false;
            return vec![0; n];
        }
        self.pcm.drain(..n).collect()
    }
}

/// Keep the pipe into aplay small, so audio isn't buffered far ahead of what
/// is actually playing (marks would fire early otherwise).
fn shrink_pipe(stdin: &ChildStdin) {
    use std::os::fd::AsRawFd;
    unsafe {
        libc::fcntl(stdin.as_raw_fd(), libc::F_SETPIPE_SZ, 4096);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1 kHz: 2 bytes per ms, so the delay is 200 bytes and the cap 800.
    fn buf() -> PlayedBuffer {
        PlayedBuffer::new(1000)
    }

    #[test]
    fn waits_for_the_delay_then_pairs_in_order() {
        let mut b = buf();
        b.push(&[1; 100]);
        assert_eq!(b.take(40), vec![0; 40]);
        b.push(&[2; 100]);
        assert_eq!(b.take(40), vec![1; 40]);
    }

    #[test]
    fn bursty_capture_takes_whole_frames() {
        // Played arrives a frame at a time, captured in bursts of six: once
        // primed, every captured frame gets played audio, none split.
        let mut b = buf();
        for _ in 0..5 {
            b.push(&[1; 40]);
        }
        let mut silent = 0;
        for _ in 0..20 {
            for _ in 0..6 {
                b.push(&[1; 40]);
            }
            for _ in 0..6 {
                if b.take(40) == vec![0; 40] {
                    silent += 1;
                }
            }
        }
        assert_eq!(silent, 0);
    }

    #[test]
    fn running_dry_waits_for_the_delay_again() {
        let mut b = buf();
        b.push(&[1; 200]);
        assert_eq!(b.take(160), vec![1; 160]);
        // 40 left: not a whole frame of 60, so silence until 200 again.
        assert_eq!(b.take(60), vec![0; 60]);
        b.push(&[2; 100]);
        assert_eq!(b.take(60), vec![0; 60]);
        b.push(&[2; 60]);
        assert_eq!(b.take(60), [vec![1; 40], vec![2; 20]].concat());
    }

    #[test]
    fn capture_falling_behind_drops_back_to_the_delay() {
        let mut b = buf();
        b.push(&[1; 800]);
        b.push(&[2; 2]);
        assert_eq!(b.pcm.len(), 200);
        assert_eq!(b.take(2), vec![1; 2]);
    }
}
