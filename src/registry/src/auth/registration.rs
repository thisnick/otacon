use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{watch, RwLock};

use super::store::{AuthScope, AuthStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRegistration {
    pub id: String,
    pub host_id: String,
    pub hostname: Option<String>,
    pub tailnet_node_id: Option<String>,
    pub status: RegistrationStatus,
    pub token_id: Option<String>,
    pub requested_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

/// Result delivered to a polling node after approval or rejection.
#[derive(Debug, Clone, Serialize)]
pub struct PollResult {
    pub status: RegistrationStatus,
    /// Raw token, only set on approval.
    pub token: Option<String>,
}

pub struct RegistrationStore {
    pub registrations: RwLock<HashMap<String, PendingRegistration>>,
    /// Per-registration notification channels. The node long-polls by waiting on rx.
    notifiers: Arc<RwLock<HashMap<String, watch::Sender<Option<PollResult>>>>>,
    data_dir: PathBuf,
    auth_store: Arc<AuthStore>,
}

impl RegistrationStore {
    pub async fn load(data_dir: &Path, auth_store: Arc<AuthStore>) -> Self {
        let path = data_dir.join("registrations.json");
        let registrations: HashMap<String, PendingRegistration> =
            match tokio::fs::read_to_string(&path).await {
                Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
                Err(_) => HashMap::new(),
            };

        Self {
            registrations: RwLock::new(registrations),
            notifiers: Arc::new(RwLock::new(HashMap::new())),
            data_dir: data_dir.to_path_buf(),
            auth_store,
        }
    }

    async fn save(&self) {
        let regs = self.registrations.read().await;
        if let Ok(data) = serde_json::to_string_pretty(&*regs) {
            tokio::fs::write(self.data_dir.join("registrations.json"), data)
                .await
                .ok();
        }
    }

    /// Create a new pending registration. Returns the pending_id.
    pub async fn register(
        &self,
        host_id: String,
        hostname: Option<String>,
        tailnet_node_id: Option<String>,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();

        let reg = PendingRegistration {
            id: id.clone(),
            host_id,
            hostname,
            tailnet_node_id,
            status: RegistrationStatus::Pending,
            token_id: None,
            requested_at: Utc::now(),
            resolved_at: None,
        };

        // Create the watch channel for long-poll notification
        let (tx, _) = watch::channel(None);
        self.notifiers.write().await.insert(id.clone(), tx);

        self.registrations.write().await.insert(id.clone(), reg);
        self.save().await;

        eprintln!("[auth] New registration pending: {id}");
        id
    }

    /// Long-poll for registration result. Returns when approved/rejected or on timeout.
    pub async fn poll(
        &self,
        pending_id: &str,
        timeout: std::time::Duration,
    ) -> Option<PollResult> {
        // Get or create a watch receiver for this registration
        let rx = {
            let notifiers = self.notifiers.read().await;
            notifiers.get(pending_id).map(|tx| tx.subscribe())
        };

        let mut rx = match rx {
            Some(rx) => rx,
            None => {
                // Registration doesn't exist or already cleaned up
                // Check if it was already resolved
                let regs = self.registrations.read().await;
                if let Some(reg) = regs.get(pending_id) {
                    match reg.status {
                        RegistrationStatus::Approved => {
                            // Already approved but we don't have the raw token anymore.
                            // The node should have received it from the first poll.
                            return None;
                        }
                        RegistrationStatus::Rejected => {
                            return Some(PollResult {
                                status: RegistrationStatus::Rejected,
                                token: None,
                            });
                        }
                        RegistrationStatus::Pending => {
                            // Re-create the notifier
                            let (tx, rx) = watch::channel(None);
                            self.notifiers.write().await.insert(pending_id.to_string(), tx);
                            rx
                        }
                    }
                } else {
                    return None;
                }
            }
        };

        // Wait for notification or timeout
        let result = tokio::time::timeout(timeout, async {
            loop {
                if rx.changed().await.is_err() {
                    return None;
                }
                let val = rx.borrow().clone();
                if val.is_some() {
                    return val;
                }
            }
        })
        .await;

        match result {
            Ok(poll_result) => poll_result,
            Err(_) => None, // Timeout — node should retry
        }
    }

    /// Approve a pending registration. Creates a node token and notifies the poller.
    pub async fn approve(&self, pending_id: &str) -> Result<String, String> {
        let mut regs = self.registrations.write().await;
        let reg = regs
            .get_mut(pending_id)
            .ok_or_else(|| "registration not found".to_string())?;

        if reg.status != RegistrationStatus::Pending {
            return Err(format!("registration already {:?}", reg.status));
        }

        // Create node token
        let (token_id, raw_token) = self
            .auth_store
            .create_token(
                AuthScope::Node,
                Some(reg.host_id.clone()),
                Some(format!("Auto-created for host {}", reg.host_id)),
            )
            .await;

        reg.status = RegistrationStatus::Approved;
        reg.token_id = Some(token_id);
        reg.resolved_at = Some(Utc::now());

        let host_id = reg.host_id.clone();
        drop(regs);
        self.save().await;

        // Notify the long-poller
        let notifiers = self.notifiers.read().await;
        if let Some(tx) = notifiers.get(pending_id) {
            let _ = tx.send(Some(PollResult {
                status: RegistrationStatus::Approved,
                token: Some(raw_token.clone()),
            }));
        }
        drop(notifiers);

        // Cleanup the notifier after a short delay
        let pending_id_owned = pending_id.to_string();
        let notifiers = self.notifiers.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            notifiers.write().await.remove(&pending_id_owned);
        });

        eprintln!("[auth] Registration {pending_id} approved for host {host_id}");
        Ok(raw_token)
    }

    /// Reject a pending registration.
    pub async fn reject(&self, pending_id: &str) -> Result<(), String> {
        let mut regs = self.registrations.write().await;
        let reg = regs
            .get_mut(pending_id)
            .ok_or_else(|| "registration not found".to_string())?;

        if reg.status != RegistrationStatus::Pending {
            return Err(format!("registration already {:?}", reg.status));
        }

        reg.status = RegistrationStatus::Rejected;
        reg.resolved_at = Some(Utc::now());
        drop(regs);
        self.save().await;

        // Notify the long-poller
        let notifiers = self.notifiers.read().await;
        if let Some(tx) = notifiers.get(pending_id) {
            let _ = tx.send(Some(PollResult {
                status: RegistrationStatus::Rejected,
                token: None,
            }));
        }

        // Cleanup
        let pending_id_owned = pending_id.to_string();
        let notifiers_clone = self.notifiers.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            notifiers_clone.write().await.remove(&pending_id_owned);
        });

        eprintln!("[auth] Registration {pending_id} rejected");
        Ok(())
    }

    /// List pending registrations (for admin view).
    pub async fn list_pending(&self) -> Vec<PendingRegistration> {
        let regs = self.registrations.read().await;
        let mut result: Vec<PendingRegistration> = regs
            .values()
            .filter(|r| r.status == RegistrationStatus::Pending)
            .cloned()
            .collect();
        result.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        result
    }

    /// List all registrations (for admin view).
    #[allow(dead_code)]
    pub async fn list_all(&self) -> Vec<PendingRegistration> {
        let regs = self.registrations.read().await;
        let mut result: Vec<PendingRegistration> = regs.values().cloned().collect();
        result.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_stores() -> (Arc<AuthStore>, RegistrationStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let auth_store = Arc::new(AuthStore::load(dir.path()).await);
        let reg_store = RegistrationStore::load(dir.path(), auth_store.clone()).await;
        (auth_store, reg_store, dir)
    }

    #[tokio::test]
    async fn register_creates_pending_entry() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-1".into(), Some("mypi".into()), None).await;
        assert!(!id.is_empty());

        let pending = reg.list_pending().await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].host_id, "host-1");
        assert_eq!(pending[0].hostname.as_deref(), Some("mypi"));
        assert_eq!(pending[0].status, RegistrationStatus::Pending);
    }

    #[tokio::test]
    async fn approve_creates_node_token() {
        let (auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-2".into(), None, None).await;
        let raw_token = reg.approve(&id).await.expect("approve should succeed");

        assert!(raw_token.starts_with("otc_node_"));

        // Token should be valid
        let token = auth.validate(&raw_token).await.expect("token should validate");
        assert_eq!(token.node_id.as_deref(), Some("host-2"));

        // Registration should no longer be pending
        assert!(reg.list_pending().await.is_empty());

        // Registration should be marked approved
        let all = reg.list_all().await;
        assert_eq!(all[0].status, RegistrationStatus::Approved);
        assert!(all[0].token_id.is_some());
    }

    #[tokio::test]
    async fn reject_marks_registration_rejected() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-3".into(), None, None).await;
        reg.reject(&id).await.expect("reject should succeed");

        assert!(reg.list_pending().await.is_empty());
        let all = reg.list_all().await;
        assert_eq!(all[0].status, RegistrationStatus::Rejected);
    }

    #[tokio::test]
    async fn cannot_approve_already_approved() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-4".into(), None, None).await;
        reg.approve(&id).await.unwrap();

        let err = reg.approve(&id).await.unwrap_err();
        assert!(err.contains("already"), "error should mention already resolved: {err}");
    }

    #[tokio::test]
    async fn cannot_reject_already_rejected() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-5".into(), None, None).await;
        reg.reject(&id).await.unwrap();

        let err = reg.reject(&id).await.unwrap_err();
        assert!(err.contains("already"));
    }

    #[tokio::test]
    async fn approve_nonexistent_returns_error() {
        let (_auth, reg, _dir) = test_stores().await;
        let err = reg.approve("nonexistent").await.unwrap_err();
        assert!(err.contains("not found"));
    }

    #[tokio::test]
    async fn poll_returns_token_on_approve() {
        let (_auth, reg, _dir) = test_stores().await;
        let reg = Arc::new(reg);

        let id = reg.register("host-6".into(), None, None).await;

        // Spawn a poller
        let reg_clone = reg.clone();
        let id_clone = id.clone();
        let poll_handle = tokio::spawn(async move {
            reg_clone.poll(&id_clone, std::time::Duration::from_secs(5)).await
        });

        // Small delay to ensure poller is waiting
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Approve
        reg.approve(&id).await.unwrap();

        // Poller should wake up with the token
        let result = poll_handle.await.unwrap().expect("poll should return result");
        assert_eq!(result.status, RegistrationStatus::Approved);
        assert!(result.token.is_some());
        assert!(result.token.unwrap().starts_with("otc_node_"));
    }

    #[tokio::test]
    async fn poll_returns_rejected_on_reject() {
        let (_auth, reg, _dir) = test_stores().await;
        let reg = Arc::new(reg);

        let id = reg.register("host-7".into(), None, None).await;

        let reg_clone = reg.clone();
        let id_clone = id.clone();
        let poll_handle = tokio::spawn(async move {
            reg_clone.poll(&id_clone, std::time::Duration::from_secs(5)).await
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        reg.reject(&id).await.unwrap();

        let result = poll_handle.await.unwrap().expect("poll should return result");
        assert_eq!(result.status, RegistrationStatus::Rejected);
        assert!(result.token.is_none());
    }

    #[tokio::test]
    async fn poll_times_out() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-8".into(), None, None).await;
        // Very short timeout
        let result = reg.poll(&id, std::time::Duration::from_millis(50)).await;
        assert!(result.is_none(), "poll should return None on timeout");
    }

    #[tokio::test]
    async fn poll_nonexistent_returns_none() {
        let (_auth, reg, _dir) = test_stores().await;
        let result = reg.poll("nonexistent", std::time::Duration::from_millis(50)).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn registrations_persist_to_disk() {
        let dir = TempDir::new().unwrap();

        let id;
        {
            let auth = Arc::new(AuthStore::load(dir.path()).await);
            let reg = RegistrationStore::load(dir.path(), auth).await;
            id = reg.register("host-persist".into(), None, None).await;
        }

        // Reload
        let auth2 = Arc::new(AuthStore::load(dir.path()).await);
        let reg2 = RegistrationStore::load(dir.path(), auth2).await;
        let pending = reg2.list_pending().await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].host_id, "host-persist");
    }
}
