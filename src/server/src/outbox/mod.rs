//! Outbox: persistent event queue for reliable host → registry delivery.
//!
//! Events are enqueued into SQLite, then flushed to the registry by a
//! background task (strict in-order, single in-flight).

pub mod events;
pub mod flusher;
pub mod store;

use std::path::Path;
use std::sync::Arc;

use events::FleetEvent;
use flusher::Flusher;
use store::OutboxStore;
use tokio::sync::Notify;

/// Outbox handle shared across the application.
pub struct Outbox {
    store: Arc<OutboxStore>,
    notify: Arc<Notify>,
}

impl Outbox {
    /// Initialize the outbox: open DB and spawn the flusher.
    pub fn init(
        db_path: &Path,
        registry_url: String,
        host_id: String,
    ) -> Result<Self, rusqlite::Error> {
        let store = Arc::new(OutboxStore::open(db_path)?);
        let flusher = Flusher::new(store.clone(), registry_url, host_id);
        let notify = flusher.notify.clone();

        tokio::spawn(async move {
            flusher.run().await;
        });

        Ok(Self { store, notify })
    }

    /// Enqueue an event and wake the flusher.
    pub fn enqueue(&self, event: &FleetEvent) -> Result<i64, rusqlite::Error> {
        let seq = self.store.enqueue(event)?;
        self.notify.notify_one();
        Ok(seq)
    }

    /// Number of unsent events (for diagnostics/health).
    pub fn unsent_count(&self) -> Result<i64, rusqlite::Error> {
        self.store.unsent_count()
    }
}
