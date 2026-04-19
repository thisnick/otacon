use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use std::sync::Arc;

use super::store::{AuthScope, AuthStore, Token};

/// Extension attached to the request after successful auth.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AuthContext {
    pub token: Token,
}

/// Middleware that requires a valid bearer token with the given scope.
pub async fn require_scope(
    required: AuthScope,
    auth_store: Arc<AuthStore>,
    admin_users: Vec<String>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(ref header) = auth_header {
        if let Some(raw_token) = header.strip_prefix("Bearer ") {
            if let Some(token) = auth_store.validate(raw_token).await {
                if token.scope != required {
                    eprintln!(
                        "[auth] Scope mismatch: token has {:?}, endpoint requires {:?}",
                        token.scope, required
                    );
                    return Err(StatusCode::FORBIDDEN);
                }
                req.extensions_mut().insert(AuthContext { token });
                return Ok(next.run(req).await);
            }
            // Token was present but invalid
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    // For admin scope: also accept Tailscale identity (whois)
    if required == AuthScope::Admin && !admin_users.is_empty() {
        // Check Tailscale-User header (set by TS proxy) or similar
        // For now, this is a placeholder — the admin sidecar's Tailscale
        // identity check would go here. Bearer token is the MVP.
    }

    Err(StatusCode::UNAUTHORIZED)
}

/// Create a node-scope auth middleware layer.
pub fn node_auth_layer(
    auth_store: Arc<AuthStore>,
) -> impl Fn(Request, Next) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response, StatusCode>> + Send>>
       + Clone
       + Send {
    move |req, next| {
        let store = auth_store.clone();
        Box::pin(require_scope(
            AuthScope::Node,
            store,
            vec![],
            req,
            next,
        ))
    }
}

/// Create an admin-scope auth middleware layer.
pub fn admin_auth_layer(
    auth_store: Arc<AuthStore>,
    admin_users: Vec<String>,
) -> impl Fn(Request, Next) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response, StatusCode>> + Send>>
       + Clone
       + Send {
    move |req, next| {
        let store = auth_store.clone();
        let users = admin_users.clone();
        Box::pin(require_scope(
            AuthScope::Admin,
            store,
            users,
            req,
            next,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_store_with_tokens() -> (Arc<AuthStore>, String, String, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(AuthStore::load(dir.path()).await);
        let (_, node_raw) = store.create_token(AuthScope::Node, Some("h1".into()), None).await;
        let (_, admin_raw) = store.create_token(AuthScope::Admin, None, None).await;
        (store, node_raw, admin_raw, dir)
    }

    // Test the auth decision logic directly: validate token + check scope.
    // We can't construct Axum's Next (opaque type), so we replicate the
    // exact allow/deny logic from require_scope here.

    async fn auth_decision(
        store: &AuthStore,
        raw_token: Option<&str>,
        required_scope: AuthScope,
    ) -> Result<Token, StatusCode> {
        match raw_token {
            None => Err(StatusCode::UNAUTHORIZED),
            Some(raw) => {
                match store.validate(raw).await {
                    None => Err(StatusCode::UNAUTHORIZED),
                    Some(token) => {
                        if token.scope != required_scope {
                            Err(StatusCode::FORBIDDEN)
                        } else {
                            Ok(token)
                        }
                    }
                }
            }
        }
    }

    // ── Node scope matrix ────────────────────────────────────────

    #[tokio::test]
    async fn node_token_on_node_endpoint_allowed() {
        let (store, node_raw, _, _dir) = test_store_with_tokens().await;
        let result = auth_decision(&store, Some(&node_raw), AuthScope::Node).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().scope, AuthScope::Node);
    }

    #[tokio::test]
    async fn admin_token_on_node_endpoint_forbidden() {
        let (store, _, admin_raw, _dir) = test_store_with_tokens().await;
        let result = auth_decision(&store, Some(&admin_raw), AuthScope::Node).await;
        assert_eq!(result.unwrap_err(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn no_token_on_node_endpoint_unauthorized() {
        let (store, _, _, _dir) = test_store_with_tokens().await;
        let result = auth_decision(&store, None, AuthScope::Node).await;
        assert_eq!(result.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn bogus_token_on_node_endpoint_unauthorized() {
        let (store, _, _, _dir) = test_store_with_tokens().await;
        let result = auth_decision(&store, Some("otc_node_fake"), AuthScope::Node).await;
        assert_eq!(result.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    // ── Admin scope matrix ───────────────────────────────────────

    #[tokio::test]
    async fn admin_token_on_admin_endpoint_allowed() {
        let (store, _, admin_raw, _dir) = test_store_with_tokens().await;
        let result = auth_decision(&store, Some(&admin_raw), AuthScope::Admin).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().scope, AuthScope::Admin);
    }

    #[tokio::test]
    async fn node_token_on_admin_endpoint_forbidden() {
        let (store, node_raw, _, _dir) = test_store_with_tokens().await;
        let result = auth_decision(&store, Some(&node_raw), AuthScope::Admin).await;
        assert_eq!(result.unwrap_err(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn no_token_on_admin_endpoint_unauthorized() {
        let (store, _, _, _dir) = test_store_with_tokens().await;
        let result = auth_decision(&store, None, AuthScope::Admin).await;
        assert_eq!(result.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    // ── Revoked token scope check ────────────────────────────────

    #[tokio::test]
    async fn revoked_node_token_unauthorized() {
        let (store, node_raw, _, _dir) = test_store_with_tokens().await;
        // Find the token ID
        let tokens = store.list_tokens().await;
        let node_token = tokens.iter().find(|t| t.scope == AuthScope::Node).unwrap();
        store.revoke(&node_token.id).await;

        let result = auth_decision(&store, Some(&node_raw), AuthScope::Node).await;
        assert_eq!(result.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn revoked_admin_token_unauthorized() {
        let (store, _, admin_raw, _dir) = test_store_with_tokens().await;
        let tokens = store.list_tokens().await;
        let admin_token = tokens.iter().find(|t| t.scope == AuthScope::Admin).unwrap();
        store.revoke(&admin_token.id).await;

        let result = auth_decision(&store, Some(&admin_raw), AuthScope::Admin).await;
        assert_eq!(result.unwrap_err(), StatusCode::UNAUTHORIZED);
    }
}
