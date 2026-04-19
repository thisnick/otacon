use axum::middleware;
use axum::routing::{get, post};
use axum::Router;
use axum::response::Html;
use std::sync::Arc;

use crate::auth::middleware::{admin_auth_layer, node_auth_layer};
use crate::auth::store::AuthStore;
use crate::auth::registration::RegistrationStore;
use crate::store::RegistryStore;
use crate::ws;

pub mod dongles;
pub mod events;
pub mod hosts;
pub mod phones;
pub mod registration;
pub mod sims;
pub mod tokens;

async fn index() -> Html<&'static str> {
    Html(include_str!("../../static/index.html"))
}

/// Shared application state accessible to all handlers.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<RegistryStore>,
    pub auth_store: Arc<AuthStore>,
    pub registration_store: Arc<RegistrationStore>,
}

/// Build the router for registry mode (node-facing).
pub fn registry_router(state: AppState) -> Router {
    let node_auth = node_auth_layer(state.auth_store.clone());

    // Public routes (no auth) — registration flow
    let public = Router::new()
        .route("/api/v1/auth/register", post(registration::register))
        .route("/api/v1/auth/poll/{pending_id}", post(registration::poll));

    // Node-authenticated routes
    let authed = Router::new()
        .route("/api/v1/hosts/register", post(hosts::register))
        .route("/api/v1/hosts/heartbeat", post(hosts::heartbeat))
        .route("/api/v1/phones/register", post(phones::register))
        .route("/api/v1/phones/deregister", post(phones::deregister))
        .route("/api/v1/dongles/register", post(dongles::register))
        .route("/api/v1/phones/{id}/sims", post(sims::report))
        .route("/api/v1/events", post(events::report))
        .route("/ws/host/config", get(ws::host_config_ws))
        .layer(middleware::from_fn(node_auth));

    public.merge(authed).with_state(state)
}

/// Build the router for admin mode (human-facing).
pub fn admin_router(state: AppState) -> Router {
    let admin_users: Vec<String> = std::env::var("OTACON_ADMIN_USERS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim().to_string())
        .collect();

    let admin_auth = admin_auth_layer(state.auth_store.clone(), admin_users);

    let authed = Router::new()
        // Auth management
        .route("/api/v1/auth/registrations/pending", get(registration::list_pending))
        .route("/api/v1/auth/registrations/{id}/approve", post(registration::approve))
        .route("/api/v1/auth/registrations/{id}/reject", post(registration::reject))
        .route("/api/v1/auth/tokens", get(tokens::list))
        .route("/api/v1/auth/tokens/{id}/revoke", post(tokens::revoke))
        // Read-only data views
        .route("/api/v1/hosts", get(hosts::list))
        .route("/api/v1/hosts/{id}", get(hosts::get))
        .route("/api/v1/phones", get(phones::list))
        .route("/api/v1/phones/{id}", get(phones::get).patch(phones::update))
        .route("/api/v1/phones/{id}/location", get(phones::location))
        .route("/api/v1/phones/{id}/config", get(phones::get_config).put(phones::set_config))
        .route("/api/v1/sims", get(sims::list))
        .route("/api/v1/phones/{id}/sims", get(sims::list_for_phone))
        .route("/api/v1/dongles", get(dongles::list))
        .route("/api/v1/events", get(events::list))
        // WebSocket
        .route("/ws/fleet/events", get(ws::fleet_events_ws))
        .layer(middleware::from_fn(admin_auth));

    // Debug UI at root (served without extra auth — page itself makes API calls that need auth)
    Router::new()
        .route("/", get(index))
        .merge(authed)
        .with_state(state)
}
