use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;
use axum::response::Html;
use std::sync::Arc;
use utoipa::OpenApi;

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

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Otacon Registry API",
        description = "Central registry for managing fleet hosts, phones, dongles, and SIMs.",
        version = "1.0.0",
        license(name = "MIT"),
    ),
    paths(
        // Public
        registration::register_host,
        registration::register_client,
        registration::poll_host,
        registration::poll_client,
        // Node scope
        hosts::identity,
        hosts::heartbeat,
        phones::register,
        phones::deregister,
        phones::delete,
        dongles::register,
        sims::report,
        events::report,
        events::ingest,
        // Admin — Registration
        registration::list_pending_hosts,
        registration::list_pending_clients,
        registration::approve_host,
        registration::approve_client,
        registration::reject_host,
        registration::reject_client,
        // Admin — Tokens
        tokens::list,
        tokens::revoke,
        // Admin — Fleet
        hosts::list,
        hosts::get,
        phones::list,
        phones::get_detail,
        phones::get_config,
        phones::set_config,
        sims::list,
        phones::admin_delete,
        hosts::admin_delete,
        dongles::admin_delete,
        dongles::list,
        events::list,
    ),
    components(schemas(
        // Store types
        crate::store::Host,
        crate::store::Phone,
        crate::store::PhoneConfig,
        crate::store::Dongle,
        crate::store::SimCard,
        crate::store::Event,
        // Auth types
        crate::auth::store::Token,
        crate::auth::store::AuthScope,
        crate::auth::registration::PendingRegistration,
        crate::auth::registration::RegistrationStatus,
        crate::auth::registration::RegistrationKind,
        // Request bodies
        registration::RegisterHostBody,
        registration::RegisterClientBody,
        hosts::HostIdentityBody,
        hosts::HeartbeatBody,
        phones::RegisterPhoneBody,
        phones::DeregisterPhoneBody,
        dongles::RegisterDonglesBody,
        dongles::DongleEntry,
        sims::ReportSimsBody,
        sims::SimEntry,
        events::ReportEventBody,
        events::FleetEventBody,
    )),
    security(
        ("bearer" = []),
    ),
)]
pub struct ApiDoc;

/// Build the unified router with scope-based URL hierarchy.
pub fn build_router(state: AppState) -> Router {
    let admin_users: Vec<String> = std::env::var("OTACON_ADMIN_USERS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim().to_string())
        .collect();

    let node_auth = node_auth_layer(state.auth_store.clone());
    let admin_auth = admin_auth_layer(state.auth_store.clone(), admin_users);

    // ── Public routes (no auth) — registration flow ─────────────────
    let public = Router::new()
        .route("/api/v1/hosts/register", post(registration::register_host))
        .route("/api/v1/hosts/poll/{pending_id}", post(registration::poll_host))
        .route("/api/v1/clients/register", post(registration::register_client))
        .route("/api/v1/clients/poll/{pending_id}", post(registration::poll_client));

    // ── Node-authenticated routes (`otc_node_*`) ────────────────────
    let node_routes = Router::new()
        .route("/api/v1/hosts/identity", post(hosts::identity))
        .route("/api/v1/hosts/heartbeat", post(hosts::heartbeat))
        .route("/api/v1/hosts/phones/register", post(phones::register))
        .route("/api/v1/hosts/phones/deregister", post(phones::deregister))
        .route("/api/v1/hosts/phones/{id}", delete(phones::delete))
        .route("/api/v1/hosts/dongles/register", post(dongles::register))
        .route("/api/v1/hosts/phones/{id}/sims", post(sims::report))
        .route("/api/v1/hosts/events", post(events::report))
        .route("/api/v1/hosts/events/ingest", post(events::ingest))
        .route("/ws/host/config", get(ws::host_config_ws))
        .layer(middleware::from_fn(node_auth));

    // ── Admin-authenticated routes (`otc_admin_*`) ──────────────────
    let admin_routes = Router::new()
        // Registration management
        .route("/api/v1/admin/hosts/pending", get(registration::list_pending_hosts))
        .route("/api/v1/admin/hosts/{id}/approve", post(registration::approve_host))
        .route("/api/v1/admin/hosts/{id}/reject", post(registration::reject_host))
        .route("/api/v1/admin/clients/pending", get(registration::list_pending_clients))
        .route("/api/v1/admin/clients/{id}/approve", post(registration::approve_client))
        .route("/api/v1/admin/clients/{id}/reject", post(registration::reject_client))
        // Token management
        .route("/api/v1/admin/tokens", get(tokens::list))
        .route("/api/v1/admin/tokens/{id}/revoke", post(tokens::revoke))
        // Fleet view
        .route("/api/v1/admin/hosts", get(hosts::list))
        .route("/api/v1/admin/hosts/{id}", get(hosts::get).delete(hosts::admin_delete))
        .route("/api/v1/admin/phones", get(phones::list))
        .route("/api/v1/admin/phones/{id}", get(phones::get_detail).delete(phones::admin_delete))
        .route("/api/v1/admin/phones/{id}/config", get(phones::get_config).put(phones::set_config))
        .route("/api/v1/admin/sims", get(sims::list))
        .route("/api/v1/admin/dongles", get(dongles::list))
        .route("/api/v1/admin/dongles/{id}", delete(dongles::admin_delete))
        .route("/api/v1/admin/events", get(events::list))
        // WebSocket
        .route("/ws/fleet/events", get(ws::fleet_events_ws))
        .layer(middleware::from_fn(admin_auth));

    // UI + OpenAPI spec (no auth)
    Router::new()
        .route("/", get(index))
        .route("/api/docs/openapi.json", get(|| async {
            let spec = ApiDoc::openapi().to_json().unwrap();
            ([("content-type", "application/json")], spec)
        }))
        .merge(public)
        .merge(node_routes)
        .merge(admin_routes)
        .with_state(state)
}
