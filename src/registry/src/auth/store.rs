use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::RwLock;

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
            tokio::fs::write(self.data_dir.join("tokens.json"), data)
                .await
                .ok();
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
