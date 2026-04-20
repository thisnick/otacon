use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use super::store::{AuthScope, AuthStore};
use crate::store::atomic_write;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationKind {
    Host,
    Client,
}

impl Default for RegistrationKind {
    fn default() -> Self {
        RegistrationKind::Host
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRegistration {
    pub id: String,
    /// For host registrations this is the host_id; for client registrations a label.
    pub host_id: String,
    pub hostname: Option<String>,
    pub tailnet_node_id: Option<String>,
    #[serde(default)]
    pub kind: RegistrationKind,
    pub status: RegistrationStatus,
    pub token_id: Option<String>,
    /// Raw token stashed here temporarily after approval so the polling process can read it.
    /// Cleared after the first successful poll retrieval.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_token: Option<String>,
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
            data_dir: data_dir.to_path_buf(),
            auth_store,
        }
    }

    async fn save(&self) {
        let regs = self.registrations.read().await;
        if let Ok(data) = serde_json::to_string_pretty(&*regs) {
            atomic_write(&self.data_dir.join("registrations.json"), data.as_bytes()).await;
        }
    }

    /// Re-read all registrations from disk into the in-memory map.
    /// Required because registry and admin run as separate processes sharing a JSON file.
    async fn reload_from_disk(&self) {
        let path = self.data_dir.join("registrations.json");
        if let Ok(data) = tokio::fs::read_to_string(&path).await {
            if let Ok(map) = serde_json::from_str::<HashMap<String, PendingRegistration>>(&data) {
                *self.registrations.write().await = map;
            }
        }
    }

    /// Re-read a single registration's state from disk.
    /// Used by the poll loop to detect cross-process changes (admin approves in a different container).
    async fn reload_registration(&self, pending_id: &str) -> Option<PendingRegistration> {
        let path = self.data_dir.join("registrations.json");
        let data = tokio::fs::read_to_string(&path).await.ok()?;
        let map: HashMap<String, PendingRegistration> =
            serde_json::from_str(&data).ok()?;
        map.get(pending_id).cloned()
    }

    /// Create a new pending registration. Returns the pending_id.
    pub async fn register(
        &self,
        host_id: String,
        hostname: Option<String>,
        tailnet_node_id: Option<String>,
        kind: RegistrationKind,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();

        let reg = PendingRegistration {
            id: id.clone(),
            host_id,
            hostname,
            tailnet_node_id,
            kind,
            status: RegistrationStatus::Pending,
            token_id: None,
            raw_token: None,
            requested_at: Utc::now(),
            resolved_at: None,
        };

        self.registrations.write().await.insert(id.clone(), reg);
        self.save().await;

        eprintln!("[auth] New {:?} registration pending: {id}", kind);
        id
    }

    /// Long-poll for registration result. Periodically re-reads from disk to detect
    /// cross-process approval/rejection (admin runs in a separate container).
    /// Returns when approved/rejected or on timeout.
    pub async fn poll(
        &self,
        pending_id: &str,
        timeout: std::time::Duration,
    ) -> Option<PollResult> {
        let poll_interval = std::time::Duration::from_secs(1);

        let result = tokio::time::timeout(timeout, async {
            loop {
                // Re-read from disk to pick up changes made by the admin process
                if let Some(reg) = self.reload_registration(pending_id).await {
                    match reg.status {
                        RegistrationStatus::Approved => {
                            let token = reg.raw_token.clone();
                            // Clear the raw token from disk now that it's been retrieved
                            if token.is_some() {
                                let mut regs = self.registrations.write().await;
                                if let Some(r) = regs.get_mut(pending_id) {
                                    r.status = RegistrationStatus::Approved;
                                    r.token_id = reg.token_id.clone();
                                    r.resolved_at = reg.resolved_at;
                                    r.raw_token = None;
                                }
                                drop(regs);
                                self.save().await;
                            }
                            return Some(PollResult {
                                status: RegistrationStatus::Approved,
                                token,
                            });
                        }
                        RegistrationStatus::Rejected => {
                            return Some(PollResult {
                                status: RegistrationStatus::Rejected,
                                token: None,
                            });
                        }
                        RegistrationStatus::Pending => {}
                    }
                } else {
                    // Registration not found on disk
                    return None;
                }

                tokio::time::sleep(poll_interval).await;
            }
        })
        .await;

        match result {
            Ok(poll_result) => poll_result,
            Err(_) => None, // Timeout — node should retry
        }
    }

    /// Approve a pending registration. Creates a node token and writes to disk.
    /// The polling registry process will pick up the change on its next file re-read.
    pub async fn approve(&self, pending_id: &str) -> Result<String, String> {
        // Re-read from disk — registration may have been created by a different process
        self.reload_from_disk().await;
        let mut regs = self.registrations.write().await;
        let reg = regs
            .get_mut(pending_id)
            .ok_or_else(|| "registration not found".to_string())?;

        if reg.status != RegistrationStatus::Pending {
            return Err(format!("registration already {:?}", reg.status));
        }

        // Create token with scope matching the registration kind
        let (scope, node_id, note) = match reg.kind {
            RegistrationKind::Host => (
                AuthScope::Node,
                Some(reg.host_id.clone()),
                format!("Auto-created for host {}", reg.host_id),
            ),
            RegistrationKind::Client => (
                AuthScope::Admin,
                None,
                format!("Auto-created for client {}", reg.host_id),
            ),
        };
        let (token_id, raw_token) = self
            .auth_store
            .create_token(scope, node_id, Some(note))
            .await;

        reg.status = RegistrationStatus::Approved;
        reg.token_id = Some(token_id);
        reg.raw_token = Some(raw_token.clone());
        reg.resolved_at = Some(Utc::now());

        let host_id = reg.host_id.clone();
        drop(regs);
        self.save().await;

        eprintln!("[auth] Registration {pending_id} approved for host {host_id}");
        Ok(raw_token)
    }

    /// Reject a pending registration. Writes to disk; polling process picks it up.
    pub async fn reject(&self, pending_id: &str) -> Result<(), String> {
        // Re-read from disk — registration may have been created by a different process
        self.reload_from_disk().await;
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

        eprintln!("[auth] Registration {pending_id} rejected");
        Ok(())
    }

    /// List pending registrations (for admin view).
    pub async fn list_pending(&self) -> Vec<PendingRegistration> {
        self.reload_from_disk().await;
        let regs = self.registrations.read().await;
        let mut result: Vec<PendingRegistration> = regs
            .values()
            .filter(|r| r.status == RegistrationStatus::Pending)
            .cloned()
            .collect();
        result.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        result
    }

    /// List pending registrations of a specific kind (for admin view).
    pub async fn list_pending_by_kind(&self, kind: RegistrationKind) -> Vec<PendingRegistration> {
        self.reload_from_disk().await;
        let regs = self.registrations.read().await;
        let mut result: Vec<PendingRegistration> = regs
            .values()
            .filter(|r| r.status == RegistrationStatus::Pending && r.kind == kind)
            .cloned()
            .collect();
        result.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        result
    }

    /// List all registrations (for admin view).
    #[allow(dead_code)]
    pub async fn list_all(&self) -> Vec<PendingRegistration> {
        self.reload_from_disk().await;
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

        let id = reg.register("host-1".into(), Some("mypi".into()), None, RegistrationKind::Host).await;
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

        let id = reg.register("host-2".into(), None, None, RegistrationKind::Host).await;
        let raw_token = reg.approve(&id).await.expect("approve should succeed");

        assert!(raw_token.starts_with("otc_node_"));

        // Token should be valid
        let token = auth.validate(&raw_token).await.expect("token should validate");
        assert_eq!(token.node_id.as_deref(), Some("host-2"));

        // Registration should no longer be pending
        assert!(reg.list_pending().await.is_empty());

        // Registration should be marked approved with raw_token stashed
        let all = reg.list_all().await;
        assert_eq!(all[0].status, RegistrationStatus::Approved);
        assert!(all[0].token_id.is_some());
        assert!(all[0].raw_token.is_some(), "raw_token should be stashed for poll retrieval");
    }

    #[tokio::test]
    async fn reject_marks_registration_rejected() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-3".into(), None, None, RegistrationKind::Host).await;
        reg.reject(&id).await.expect("reject should succeed");

        assert!(reg.list_pending().await.is_empty());
        let all = reg.list_all().await;
        assert_eq!(all[0].status, RegistrationStatus::Rejected);
    }

    #[tokio::test]
    async fn cannot_approve_already_approved() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-4".into(), None, None, RegistrationKind::Host).await;
        reg.approve(&id).await.unwrap();

        let err = reg.approve(&id).await.unwrap_err();
        assert!(err.contains("already"), "error should mention already resolved: {err}");
    }

    #[tokio::test]
    async fn cannot_reject_already_rejected() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-5".into(), None, None, RegistrationKind::Host).await;
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

        let id = reg.register("host-6".into(), None, None, RegistrationKind::Host).await;

        // Spawn a poller — it will re-read the file every 1s
        let reg_clone = reg.clone();
        let id_clone = id.clone();
        let poll_handle = tokio::spawn(async move {
            reg_clone.poll(&id_clone, std::time::Duration::from_secs(10)).await
        });

        // Small delay then approve — the poller's next file re-read will pick it up
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        reg.approve(&id).await.unwrap();

        // Poller should wake up with the token within ~1s
        let result = poll_handle.await.unwrap().expect("poll should return result");
        assert_eq!(result.status, RegistrationStatus::Approved);
        assert!(result.token.is_some());
        assert!(result.token.unwrap().starts_with("otc_node_"));
    }

    #[tokio::test]
    async fn poll_returns_rejected_on_reject() {
        let (_auth, reg, _dir) = test_stores().await;
        let reg = Arc::new(reg);

        let id = reg.register("host-7".into(), None, None, RegistrationKind::Host).await;

        let reg_clone = reg.clone();
        let id_clone = id.clone();
        let poll_handle = tokio::spawn(async move {
            reg_clone.poll(&id_clone, std::time::Duration::from_secs(10)).await
        });

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        reg.reject(&id).await.unwrap();

        let result = poll_handle.await.unwrap().expect("poll should return result");
        assert_eq!(result.status, RegistrationStatus::Rejected);
        assert!(result.token.is_none());
    }

    #[tokio::test]
    async fn poll_clears_raw_token_after_retrieval() {
        let (_auth, reg, _dir) = test_stores().await;
        let reg = Arc::new(reg);

        let id = reg.register("host-clear".into(), None, None, RegistrationKind::Host).await;
        reg.approve(&id).await.unwrap();

        // Poll picks up the approval and clears raw_token
        let result = reg.poll(&id, std::time::Duration::from_millis(500)).await;
        assert!(result.is_some());
        assert!(result.unwrap().token.is_some());

        // raw_token should now be cleared on disk
        let disk_reg = reg.reload_registration(&id).await.unwrap();
        assert!(disk_reg.raw_token.is_none(), "raw_token should be cleared after poll retrieval");
    }

    #[tokio::test]
    async fn poll_times_out() {
        let (_auth, reg, _dir) = test_stores().await;

        let id = reg.register("host-8".into(), None, None, RegistrationKind::Host).await;
        // Short timeout — shorter than poll interval, so it times out without ever re-reading
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
            id = reg.register("host-persist".into(), None, None, RegistrationKind::Host).await;
        }

        // Reload
        let auth2 = Arc::new(AuthStore::load(dir.path()).await);
        let reg2 = RegistrationStore::load(dir.path(), auth2).await;
        let pending = reg2.list_pending().await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].host_id, "host-persist");
    }

    #[tokio::test]
    async fn atomic_write_creates_valid_file() {
        use crate::store::atomic_write;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.json");
        let data = r#"{"key": "value"}"#;
        atomic_write(&path, data.as_bytes()).await;
        let read_back = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(read_back, data);
    }

    #[tokio::test]
    async fn cross_process_approve() {
        // Simulates cross-process scenario: registry creates registration,
        // admin (separate store instance) approves it.
        let dir = TempDir::new().unwrap();

        // "Registry process" — creates registration
        let auth1 = Arc::new(AuthStore::load(dir.path()).await);
        let registry = RegistrationStore::load(dir.path(), auth1.clone()).await;
        let id = registry.register("host-cross".into(), Some("pi".into()), None, RegistrationKind::Host).await;

        // "Admin process" — loaded after registration was created, but from same data dir
        let auth2 = Arc::new(AuthStore::load(dir.path()).await);
        let admin = RegistrationStore::load(dir.path(), auth2.clone()).await;

        // Admin should see the pending registration (reload_from_disk on list_pending)
        let pending = admin.list_pending().await;
        assert_eq!(pending.len(), 1, "admin should see registry's pending registration");
        assert_eq!(pending[0].id, id);

        // Admin approves — reload_from_disk should find the registration
        let raw_token = admin.approve(&id).await.expect("cross-process approve should succeed");
        assert!(raw_token.starts_with("otc_node_"));

        // Registry's poll should pick up the approval from disk
        let result = registry.poll(&id, std::time::Duration::from_millis(500)).await;
        assert!(result.is_some());
        let result = result.unwrap();
        assert_eq!(result.status, RegistrationStatus::Approved);
        assert!(result.token.unwrap().starts_with("otc_node_"));
    }
}
