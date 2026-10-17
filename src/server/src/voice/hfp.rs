//! The HFP control link: BlueALSA's RFCOMM pass-through for one phone.
//!
//! BlueALSA hands out the channel to one client at a time
//! (`org.bluealsa.RFCOMM1.Open`, a second open fails with "busy"), so the
//! server owns it for as long as the phone is connected and everything else
//! goes through the server.

use std::collections::VecDeque;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::at::{classify, Final, Line, Unsolicited};

#[derive(Debug)]
pub enum AtError {
    /// The phone answered ERROR (or +CME ERROR, NO CARRIER, ...)
    Phone(String),
    Timeout,
    Closed,
}

struct Req {
    cmd: String,
    timeout: Duration,
    reply: oneshot::Sender<Result<Vec<String>, AtError>>,
}

/// While this file exists, every AT line sent and received is logged (for
/// debugging a phone's HFP behaviour without a rebuild).
const TRACE_FLAG: &str = "/tmp/hfp-trace";

fn trace(phone_id: &str, dir: &str, line: &str) {
    if std::path::Path::new(TRACE_FLAG).exists() {
        eprintln!("[{phone_id}] hfp {dir} {:?}", line.trim_end());
    }
}

/// How long the line stays reserved for a command whose caller already gave
/// up, waiting for its late reply.
const LATE_REPLY_GRACE: Duration = Duration::from_secs(3);


struct Pending {
    cmd: String,
    /// None once the caller has been told it timed out
    reply: Option<oneshot::Sender<Result<Vec<String>, AtError>>>,
    lines: Vec<String>,
    soft: Instant,
    hard: Instant,
}

/// Sends AT commands on the link, one at a time.
#[derive(Clone)]
pub struct HfpHandle {
    tx: mpsc::Sender<Req>,
}

impl HfpHandle {
    /// Send one command and collect its information lines until the final
    /// result.
    pub async fn at(&self, cmd: &str, timeout: Duration) -> Result<Vec<String>, AtError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Req { cmd: cmd.to_string(), timeout, reply })
            .await
            .map_err(|_| AtError::Closed)?;
        rx.await.unwrap_or(Err(AtError::Closed))
    }
}

/// Find the phone's RFCOMM object (`/org/bluealsa/hciN/dev_XX_.../rfcomm`).
/// The adapter changes when the phone is re-bound to another dongle, so this
/// is looked up by the phone's MAC each time.
pub async fn find_rfcomm_path(conn: &zbus::Connection, phone_mac: &str) -> Option<String> {
    let proxy = zbus::fdo::ObjectManagerProxy::builder(conn)
        .destination("org.bluealsa")
        .ok()?
        .path("/org/bluealsa")
        .ok()?
        .build()
        .await
        .ok()?;
    let objects = proxy.get_managed_objects().await.ok()?;
    let dev = format!("dev_{}", phone_mac.to_uppercase().replace(':', "_"));
    objects
        .keys()
        .map(|p| p.to_string())
        .find(|p| p.ends_with("/rfcomm") && p.split('/').any(|seg| seg == dev))
}

pub async fn open(conn: &zbus::Connection, path: &str) -> Result<UnixStream, String> {
    let reply = conn
        .call_method(Some("org.bluealsa"), path, Some("org.bluealsa.RFCOMM1"), "Open", &())
        .await
        .map_err(|e| e.to_string())?;
    let fd: zbus::zvariant::OwnedFd = reply.body().deserialize().map_err(|e| e.to_string())?;
    let fd: std::os::fd::OwnedFd = fd.into();
    let stream = std::os::unix::net::UnixStream::from(fd);
    stream.set_nonblocking(true).map_err(|e| e.to_string())?;
    UnixStream::from_std(stream).map_err(|e| e.to_string())
}

/// Start the link. Unsolicited lines (+CIEV, RING, ...) arrive on the
/// returned receiver, which closes when the link does.
pub fn start(
    stream: UnixStream,
    phone_id: String,
) -> (HfpHandle, mpsc::UnboundedReceiver<Unsolicited>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<Req>(32);
    let (unsol_tx, unsol_rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(stream, rx, unsol_tx, phone_id));
    (HfpHandle { tx }, unsol_rx, task)
}

async fn run(
    stream: UnixStream,
    mut rx: mpsc::Receiver<Req>,
    unsol_tx: mpsc::UnboundedSender<Unsolicited>,
    phone_id: String,
) {
    let (rd, mut wr) = stream.into_split();

    // Lines are read in their own task so a half-read line is never lost to
    // a select! cancellation.
    let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
    let reader = tokio::spawn(async move {
        let mut rd = BufReader::new(rd);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match rd.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line_tx.send(String::from_utf8_lossy(&buf).into_owned()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut queue: VecDeque<Req> = VecDeque::new();
    let mut current: Option<Pending> = None;

    loop {
        if current.is_none() {
            if let Some(req) = queue.pop_front() {
                trace(&phone_id, ">", &req.cmd);
                if wr.write_all(format!("{}\r", req.cmd).as_bytes()).await.is_err() {
                    let _ = req.reply.send(Err(AtError::Closed));
                    break;
                }
                let now = Instant::now();
                current = Some(Pending {
                    cmd: req.cmd,
                    reply: Some(req.reply),
                    lines: Vec::new(),
                    soft: now + req.timeout,
                    hard: now + req.timeout + LATE_REPLY_GRACE,
                });
            }
        }
        let deadline = current.as_ref().map(|c| if c.reply.is_some() { c.soft } else { c.hard });

        tokio::select! {
            req = rx.recv() => match req {
                Some(r) => queue.push_back(r),
                None => break,
            },
            line = line_rx.recv() => {
                let Some(line) = line else { break };
                if !line.trim().is_empty() {
                    trace(&phone_id, "<", &line);
                }
                match classify(&line) {
                    None => {}
                    Some(Line::Final(f)) => match current.take() {
                        Some(Pending { reply: Some(reply), lines, .. }) => {
                            let _ = reply.send(match f {
                                Final::Ok => Ok(lines),
                                Final::Error(e) => Err(AtError::Phone(e)),
                            });
                        }
                        Some(p) => eprintln!("[{phone_id}] hfp: late reply to {} discarded", p.cmd),
                        None => eprintln!("[{phone_id}] hfp: unexpected final {line:?}"),
                    },
                    Some(Line::Unsolicited(u)) => {
                        let _ = unsol_tx.send(u);
                    }
                    Some(Line::Info(s)) => match current.as_mut() {
                        Some(p) => {
                            if p.reply.is_some() {
                                if !p.lines.contains(&s) {
                                    p.lines.push(s);
                                }
                            }
                        }
                        None => eprintln!("[{phone_id}] hfp: unexpected line {s:?}"),
                    },
                }
            },
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                if let Some(p) = current.as_mut() {
                    match p.reply.take() {
                        // The caller stops waiting, but the line stays busy
                        // until the phone answers, so a late reply can't be
                        // taken for the next command's.
                        // A list whose lines came in but whose OK never did:
                        // BlueALSA takes the next OK for itself while it has
                        // a command of its own outstanding. Use the lines.
                        Some(reply) if p.cmd == "AT+CLCC" && !p.lines.is_empty() => {
                            eprintln!("[{phone_id}] hfp: {} got its lines but no OK; using them", p.cmd);
                            let _ = reply.send(Ok(std::mem::take(&mut p.lines)));
                        }
                        Some(reply) => {
                            eprintln!("[{phone_id}] hfp: {} timed out", p.cmd);
                            let _ = reply.send(Err(AtError::Timeout));
                        }
                        None => {
                            eprintln!("[{phone_id}] hfp: no reply to {}; moving on", p.cmd);
                            current = None;
                        }
                    }
                }
            },
        }
    }

    reader.abort();
    if let Some(Pending { reply: Some(reply), .. }) = current.take() {
        let _ = reply.send(Err(AtError::Closed));
    }
    for req in queue {
        let _ = req.reply.send(Err(AtError::Closed));
    }
}
