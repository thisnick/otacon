//! SQLite-backed outbox store.
//!
//! Events are written here by the reconciler or fleet client, then flushed
//! to the registry by the flusher task.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use super::events::FleetEvent;

/// A persisted outbox event row.
#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub seq: i64,
    pub event_type: String,
    pub entity_id: Option<String>,
    pub data: String,
    pub created_at: String,
    pub attempts: i32,
    pub last_error: Option<String>,
}

pub struct OutboxStore {
    conn: Mutex<Connection>,
}

impl OutboxStore {
    /// Open (or create) the outbox database at the given path.
    pub fn open(db_path: &Path) -> Result<Self, rusqlite::Error> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                seq         INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type  TEXT NOT NULL,
                entity_id   TEXT,
                data        TEXT NOT NULL,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                sent_at     TEXT,
                attempts    INTEGER NOT NULL DEFAULT 0,
                last_error  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_unsent ON events(seq) WHERE sent_at IS NULL;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Enqueue an event. Returns the sequence number.
    pub fn enqueue(&self, event: &FleetEvent) -> Result<i64, rusqlite::Error> {
        let event_type = event.event_type().to_string();
        let entity_id = event.entity_id().map(|s| s.to_string());
        let data = serde_json::to_string(event).unwrap_or_default();

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO events (event_type, entity_id, data) VALUES (?1, ?2, ?3)",
            params![event_type, entity_id, data],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Get the next unsent event (lowest seq where sent_at IS NULL).
    pub fn next_unsent(&self) -> Result<Option<OutboxRow>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT seq, event_type, entity_id, data, created_at, attempts, last_error
             FROM events WHERE sent_at IS NULL ORDER BY seq LIMIT 1",
        )?;
        let row = stmt
            .query_row([], |row| {
                Ok(OutboxRow {
                    seq: row.get(0)?,
                    event_type: row.get(1)?,
                    entity_id: row.get(2)?,
                    data: row.get(3)?,
                    created_at: row.get(4)?,
                    attempts: row.get(5)?,
                    last_error: row.get(6)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    /// Mark an event as sent.
    pub fn mark_sent(&self, seq: i64) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE events SET sent_at = datetime('now') WHERE seq = ?1",
            params![seq],
        )?;
        Ok(())
    }

    /// Record a send failure (increment attempts, store error).
    pub fn record_failure(&self, seq: i64, err: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE events SET attempts = attempts + 1, last_error = ?2 WHERE seq = ?1",
            params![seq, err],
        )?;
        Ok(())
    }

    /// Count of unsent events (for diagnostics).
    pub fn unsent_count(&self) -> Result<i64, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM events WHERE sent_at IS NULL", [], |r| {
            r.get(0)
        })
    }
}

/// Extension trait for optional row queries.
trait OptionalExt<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}

impl<T> OptionalExt<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
