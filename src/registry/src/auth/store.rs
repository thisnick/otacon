use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::RwLock;

use crate::store::atomic_write;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthScope {
    Node,
    Admin,
}

impl std::fmt::Display for AuthScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthScope::Node => write!(f, "node"),
            AuthScope::Admin => write!(f, "admin"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    pub id: String,
    pub scope: AuthScope,
    /// For node tokens, the host_id this token is bound to.
    pub node_id: Option<String>,
    /// SHA-256 hex hash of the raw token.
    pub token_hash: String,
    /// First 12 chars of the raw token, for display in admin UI.
    pub token_prefix: String,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub note: Option<String>,
}

pub struct AuthStore {
    pub tokens: RwLock<HashMap<String, Token>>,
    data_dir: PathBuf,
}

impl AuthStore {
    pub async fn load(data_dir: &Path) -> Self {
        let tokens_path = data_dir.join("tokens.json");
        let tokens: HashMap<String, Token> = match tokio::fs::read_to_string(&tokens_path).await {
            Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
            Err(_) => HashMap::new(),
        };

        Self {
            tokens: RwLock::new(tokens),
            data_dir: data_dir.to_path_buf(),
        }
    }

    pub async fn save(&self) {
        let tokens = self.tokens.read().await;
        if let Ok(data) = serde_json::to_string_pretty(&*tokens) {
            atomic_write(&self.data_dir.join("tokens.json"), data.as_bytes()).await;
        }
    }

    /// Re-read tokens from disk. Required because registry and admin run as
    /// separate processes sharing tokens.json on a Docker volume.
    async fn reload_from_disk(&self) {
        let path = self.data_dir.join("tokens.json");
        if let Ok(data) = tokio::fs::read_to_string(&path).await {
            if let Ok(map) = serde_json::from_str::<HashMap<String, Token>>(&data) {
                *self.tokens.write().await = map;
            }
        }
    }

    /// Generate a new raw token string with the appropriate prefix.
    pub fn generate_raw_token(scope: AuthScope) -> String {
        let random_bytes: [u8; 32] = rand::random();
        let hex = hex::encode(random_bytes);
        match scope {
            AuthScope::Node => format!("otc_node_{hex}"),
            AuthScope::Admin => format!("otc_admin_{hex}"),
        }
    }

    /// Hash a raw token for storage.
    pub fn hash_token(raw: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(raw.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Create and store a new token. Returns (token_id, raw_token).
    pub async fn create_token(
        &self,
        scope: AuthScope,
        node_id: Option<String>,
        note: Option<String>,
    ) -> (String, String) {
        let raw = Self::generate_raw_token(scope);
        let hash = Self::hash_token(&raw);
        let prefix = raw[..12.min(raw.len())].to_string();
        let id = uuid::Uuid::new_v4().to_string();

        let token = Token {
            id: id.clone(),
            scope,
            node_id,
            token_hash: hash,
            token_prefix: prefix,
            created_at: Utc::now(),
            last_seen_at: None,
            expires_at: None,
            revoked_at: None,
            note,
        };

        self.tokens.write().await.insert(id.clone(), token);
        self.save().await;

        (id, raw)
    }

    /// Validate a raw bearer token. Returns the Token if valid (not revoked/expired).
    pub async fn validate(&self, raw: &str) -> Option<Token> {
        // Re-read from disk — token may have been created by the admin process
        self.reload_from_disk().await;
        let hash = Self::hash_token(raw);
        let mut tokens = self.tokens.write().await;

        let token = tokens.values_mut().find(|t| t.token_hash == hash)?;

        // Check revoked
        if token.revoked_at.is_some() {
            return None;
        }

        // Check expired
        if let Some(expires) = token.expires_at {
            if Utc::now() > expires {
                return None;
            }
        }

        // Update last_seen
        token.last_seen_at = Some(Utc::now());
        let result = token.clone();

        drop(tokens);
        // Save last_seen update (fire and forget, non-critical)
        self.save().await;

        Some(result)
    }

    /// Revoke a token by its ID.
    pub async fn revoke(&self, token_id: &str) -> bool {
        self.reload_from_disk().await;
        let mut tokens = self.tokens.write().await;
        if let Some(token) = tokens.get_mut(token_id) {
            token.revoked_at = Some(Utc::now());
            drop(tokens);
            self.save().await;
            true
        } else {
            false
        }
    }

    /// List all tokens (for admin view).
    pub async fn list_tokens(&self) -> Vec<Token> {
        self.reload_from_disk().await;
        let tokens = self.tokens.read().await;
        let mut result: Vec<Token> = tokens.values().cloned().collect();
        result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        result
    }

    /// Check if any admin tokens exist.
    pub async fn has_admin_tokens(&self) -> bool {
        let tokens = self.tokens.read().await;
        tokens.values().any(|t| t.scope == AuthScope::Admin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_store() -> (AuthStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = AuthStore::load(dir.path()).await;
        (store, dir)
    }

    // ── Token generation ─────────────────────────────────────────

    #[tokio::test]
    async fn generate_node_token_format() {
        let raw = AuthStore::generate_raw_token(AuthScope::Node);
        assert!(raw.starts_with("otc_node_"), "expected otc_node_ prefix, got: {raw}");
        // otc_node_ = 9 chars + 64 hex chars = 73 total
        assert_eq!(raw.len(), 73, "expected 73 chars, got {}", raw.len());
        // hex portion should be valid hex
        let hex_part = &raw[9..];
        assert!(hex_part.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn generate_admin_token_format() {
        let raw = AuthStore::generate_raw_token(AuthScope::Admin);
        assert!(raw.starts_with("otc_admin_"), "expected otc_admin_ prefix, got: {raw}");
        // otc_admin_ = 10 chars + 64 hex chars = 74 total
        assert_eq!(raw.len(), 74, "expected 74 chars, got {}", raw.len());
        let hex_part = &raw[10..];
        assert!(hex_part.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn generate_tokens_are_unique() {
        let t1 = AuthStore::generate_raw_token(AuthScope::Node);
        let t2 = AuthStore::generate_raw_token(AuthScope::Node);
        assert_ne!(t1, t2, "two generated tokens must differ");
    }

    // ── Hashing ──────────────────────────────────────────────────

    #[tokio::test]
    async fn hash_is_sha256_hex() {
        let raw = "otc_node_deadbeef";
        let hash = AuthStore::hash_token(raw);
        // SHA-256 produces 64 hex chars
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn hash_is_deterministic() {
        let raw = "otc_node_test1234";
        let h1 = AuthStore::hash_token(raw);
        let h2 = AuthStore::hash_token(raw);
        assert_eq!(h1, h2);
    }

    #[tokio::test]
    async fn hash_does_not_contain_plaintext() {
        let raw = "otc_node_abcdef1234567890abcdef1234567890abcdef1234567890abcdef123456";
        let hash = AuthStore::hash_token(raw);
        assert!(!hash.contains("otc_node_"), "hash must not contain raw token prefix");
        assert!(!hash.contains("abcdef1234567890"), "hash must not contain raw token body");
    }

    #[tokio::test]
    async fn different_tokens_different_hashes() {
        let h1 = AuthStore::hash_token("otc_node_aaa");
        let h2 = AuthStore::hash_token("otc_node_bbb");
        assert_ne!(h1, h2);
    }

    // ── Create + validate ────────────────────────────────────────

    #[tokio::test]
    async fn create_and_validate_node_token() {
        let (store, _dir) = test_store().await;
        let (id, raw) = store.create_token(AuthScope::Node, Some("host-1".into()), None).await;

        assert!(!id.is_empty());
        assert!(raw.starts_with("otc_node_"));

        let token = store.validate(&raw).await.expect("token should validate");
        assert_eq!(token.scope, AuthScope::Node);
        assert_eq!(token.node_id.as_deref(), Some("host-1"));
        assert!(token.last_seen_at.is_some());
    }

    #[tokio::test]
    async fn create_and_validate_admin_token() {
        let (store, _dir) = test_store().await;
        let (_id, raw) = store.create_token(AuthScope::Admin, None, Some("test".into())).await;

        let token = store.validate(&raw).await.expect("token should validate");
        assert_eq!(token.scope, AuthScope::Admin);
        assert!(token.node_id.is_none());
        assert_eq!(token.note.as_deref(), Some("test"));
    }

    #[tokio::test]
    async fn validate_bogus_token_returns_none() {
        let (store, _dir) = test_store().await;
        store.create_token(AuthScope::Node, None, None).await;

        let result = store.validate("otc_node_does_not_exist").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn validate_empty_string_returns_none() {
        let (store, _dir) = test_store().await;
        assert!(store.validate("").await.is_none());
    }

    // ── Revocation ───────────────────────────────────────────────

    #[tokio::test]
    async fn revoked_token_fails_validation() {
        let (store, _dir) = test_store().await;
        let (id, raw) = store.create_token(AuthScope::Node, None, None).await;

        // Valid before revocation
        assert!(store.validate(&raw).await.is_some());

        // Revoke
        assert!(store.revoke(&id).await);

        // Invalid after revocation
        assert!(store.validate(&raw).await.is_none());
    }

    #[tokio::test]
    async fn revoke_nonexistent_returns_false() {
        let (store, _dir) = test_store().await;
        assert!(!store.revoke("nonexistent-id").await);
    }

    // ── Expiration ───────────────────────────────────────────────

    #[tokio::test]
    async fn expired_token_fails_validation() {
        let (store, _dir) = test_store().await;
        let (id, raw) = store.create_token(AuthScope::Node, None, None).await;

        // Manually set expires_at to the past and persist to disk
        {
            let mut tokens = store.tokens.write().await;
            let t = tokens.get_mut(&id).unwrap();
            t.expires_at = Some(Utc::now() - chrono::Duration::hours(1));
        }
        store.save().await;

        assert!(store.validate(&raw).await.is_none(), "expired token must not validate");
    }

    // ── Token prefix ─────────────────────────────────────────────

    #[tokio::test]
    async fn token_prefix_is_first_12_chars() {
        let (store, _dir) = test_store().await;
        let (id, raw) = store.create_token(AuthScope::Node, None, None).await;

        let tokens = store.tokens.read().await;
        let t = tokens.get(&id).unwrap();
        assert_eq!(t.token_prefix, &raw[..12]);
        // Prefix must NOT be the hash
        assert_ne!(t.token_prefix, &t.token_hash[..12]);
    }

    // ── Listing + has_admin ──────────────────────────────────────

    #[tokio::test]
    async fn list_tokens_returns_all() {
        let (store, _dir) = test_store().await;
        store.create_token(AuthScope::Node, None, None).await;
        store.create_token(AuthScope::Admin, None, None).await;

        let all = store.list_tokens().await;
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn has_admin_tokens_check() {
        let (store, _dir) = test_store().await;
        assert!(!store.has_admin_tokens().await);

        store.create_token(AuthScope::Admin, None, None).await;
        assert!(store.has_admin_tokens().await);
    }

    // ── Persistence ──────────────────────────────────────────────

    #[tokio::test]
    async fn tokens_persist_to_disk_and_reload() {
        let dir = TempDir::new().unwrap();

        let raw;
        {
            let store = AuthStore::load(dir.path()).await;
            let (_id, r) = store.create_token(AuthScope::Node, Some("h1".into()), None).await;
            raw = r;
        }

        // Reload from same directory
        let store2 = AuthStore::load(dir.path()).await;
        let token = store2.validate(&raw).await.expect("token must survive reload");
        assert_eq!(token.scope, AuthScope::Node);
        assert_eq!(token.node_id.as_deref(), Some("h1"));
    }

    #[tokio::test]
    async fn cross_process_token_visible() {
        // Simulates cross-process: admin creates token, registry validates it
        let dir = TempDir::new().unwrap();

        // "Admin process" creates a token
        let admin = AuthStore::load(dir.path()).await;
        let (_id, raw) = admin.create_token(AuthScope::Node, Some("h2".into()), None).await;

        // "Registry process" was loaded before the token was created
        let registry = AuthStore::load(dir.path()).await;
        // But it loaded from disk so it should already have it.
        // Now simulate: registry was loaded BEFORE admin created the token.
        // Clear registry's in-memory state to simulate stale cache:
        registry.tokens.write().await.clear();

        // validate() should reload from disk and find the token
        let token = registry.validate(&raw).await.expect("cross-process token must validate");
        assert_eq!(token.scope, AuthScope::Node);
        assert_eq!(token.node_id.as_deref(), Some("h2"));
    }
}
