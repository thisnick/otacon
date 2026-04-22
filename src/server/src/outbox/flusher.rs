//! Background flusher: sends outbox events to the registry one at a time.
//!
//! Rule 2: strict in-order, single in-flight. If event N fails, retry N
//! with exponential backoff before moving to N+1.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use super::store::OutboxStore;
use crate::fleet::load_auth_token;

/// Minimum backoff between retries.
const MIN_BACKOFF: Duration = Duration::from_millis(500);
/// Maximum backoff between retries.
const MAX_BACKOFF: Duration = Duration::from_secs(30);

pub struct Flusher {
    store: Arc<OutboxStore>,
    registry_url: String,
    host_id: String,
    client: reqwest::Client,
    /// Notify the flusher that new events are available.
    pub notify: Arc<Notify>,
}

impl Flusher {
    pub fn new(
        store: Arc<OutboxStore>,
        registry_url: String,
        host_id: String,
    ) -> Self {
        Self {
            store,
            registry_url: registry_url.trim_end_matches('/').to_string(),
            host_id,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Run the flusher loop forever. Call from a spawned task.
    pub async fn run(&self) {
        let mut backoff = MIN_BACKOFF;

        loop {
            // Try to flush the next unsent event
            match self.store.next_unsent() {
                Ok(Some(row)) => {
                    let url = format!(
                        "{}/api/v1/hosts/events/ingest",
                        self.registry_url
                    );

                    // Build the registry event body
                    let body = serde_json::json!({
                        "host_id": self.host_id,
                        "event_type": row.event_type,
                        "entity_id": row.entity_id,
                        "data": serde_json::from_str::<serde_json::Value>(&row.data)
                            .unwrap_or(serde_json::Value::Null),
                    });

                    let mut req = self.client.post(&url).json(&body);
                    if let Some(token) = load_auth_token() {
                        req = req.header("Authorization", format!("Bearer {token}"));
                    }

                    match req.send().await {
                        Ok(resp) if resp.status().is_success() => {
                            if let Err(e) = self.store.mark_sent(row.seq) {
                                eprintln!("[outbox] Failed to mark seq {} sent: {e}", row.seq);
                            }
                            backoff = MIN_BACKOFF; // reset on success
                            continue; // immediately try next event
                        }
                        Ok(resp) => {
                            let status = resp.status();
                            let err = format!("HTTP {status}");
                            eprintln!(
                                "[outbox] Failed to send seq {} ({}): {err}",
                                row.seq, row.event_type
                            );
                            self.store.record_failure(row.seq, &err).ok();
                        }
                        Err(e) => {
                            let err = format!("{e}");
                            eprintln!(
                                "[outbox] Send error for seq {} ({}): {err}",
                                row.seq, row.event_type
                            );
                            self.store.record_failure(row.seq, &err).ok();
                        }
                    }

                    // Failed — backoff before retrying same event
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
                Ok(None) => {
                    // No events to send — wait for notification or poll every 5s
                    backoff = MIN_BACKOFF;
                    tokio::select! {
                        _ = self.notify.notified() => {}
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                    }
                }
                Err(e) => {
                    eprintln!("[outbox] DB error reading next unsent: {e}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    }
}
