use axum::{routing::{get, post}, Router};
use std::sync::Arc;

use crate::store::RegistryStore;

pub mod dongles;
pub mod events;
pub mod hosts;
pub mod phones;
pub mod sims;

pub fn router(store: Arc<RegistryStore>) -> Router {
    Router::new()
        // Host management
        .route("/api/v1/hosts/register", post(hosts::register))
        .route("/api/v1/hosts/heartbeat", post(hosts::heartbeat))
        .route("/api/v1/hosts", get(hosts::list))
        .route("/api/v1/hosts/{id}", get(hosts::get))
        // Phone registry
        .route("/api/v1/phones", get(phones::list))
        .route("/api/v1/phones/{id}", get(phones::get).patch(phones::update))
        .route("/api/v1/phones/{id}/location", get(phones::location))
        .route("/api/v1/phones/register", post(phones::register))
        .route("/api/v1/phones/deregister", post(phones::deregister))
        // Phone config
        .route("/api/v1/phones/{id}/config", get(phones::get_config).put(phones::set_config))
        // SIM cards
        .route("/api/v1/sims", get(sims::list))
        .route("/api/v1/phones/{id}/sims", get(sims::list_for_phone).post(sims::report))
        // Dongles
        .route("/api/v1/dongles", get(dongles::list))
        .route("/api/v1/dongles/register", post(dongles::register))
        // Events
        .route("/api/v1/events", get(events::list).post(events::report))
        .with_state(store)
}
