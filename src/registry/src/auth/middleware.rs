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
