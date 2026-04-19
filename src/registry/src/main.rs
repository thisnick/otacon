use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

mod api;
mod auth;
mod store;
mod ws;

#[tokio::main]
async fn main() {
    let data_dir = std::env::var("OTACON_REGISTRY_DATA")
        .or_else(|_| std::env::var("REGISTRY_DATA_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".otacon").join("registry")
        });

    let mode = std::env::var("OTACON_SERVICE_MODE")
        .unwrap_or_default()
        .to_lowercase();

    eprintln!("[registry] Data directory: {}", data_dir.display());
    eprintln!("[registry] Service mode: {}", if mode.is_empty() { "legacy (all routes, no auth)" } else { &mode });

    let store = Arc::new(store::RegistryStore::load(&data_dir).await);
    let auth_store = Arc::new(auth::AuthStore::load(&data_dir).await);
    let registration_store = Arc::new(
        auth::registration::RegistrationStore::load(&data_dir, auth_store.clone()).await,
    );

    let port: u16 = std::env::var("OTACON_REGISTRY_PORT")
        .or_else(|_| std::env::var("REGISTRY_PORT"))
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let app_state = api::AppState {
        store: store.clone(),
        auth_store: auth_store.clone(),
        registration_store: registration_store.clone(),
    };

    let app = match mode.as_str() {
        "registry" => {
            eprintln!("[registry] Starting in REGISTRY mode (node-facing, port {port})");
            api::registry_router(app_state).layer(CorsLayer::permissive())
        }
        "admin" => {
            eprintln!("[registry] Starting in ADMIN mode (human-facing, port {port})");

            // Bootstrap: if no admin tokens exist, create one and print it
            if !auth_store.has_admin_tokens().await {
                let (token_id, raw_token) = auth_store
                    .create_token(
                        auth::AuthScope::Admin,
                        None,
                        Some("Bootstrap admin token".into()),
                    )
                    .await;
                eprintln!("╔══════════════════════════════════════════════════════════════════╗");
                eprintln!("║  BOOTSTRAP ADMIN TOKEN — save this immediately!                 ║");
                eprintln!("║  Token: {raw_token}");
                eprintln!("║  ID:    {token_id}");
                eprintln!("║  This will NOT be shown again.                                  ║");
                eprintln!("╚══════════════════════════════════════════════════════════════════╝");
            }

            api::admin_router(app_state).layer(CorsLayer::permissive())
        }
        _ => {
            // Legacy mode: all routes, no auth (backwards compatible)
            eprintln!("[registry] Starting in LEGACY mode (all routes, no auth, port {port})");
            eprintln!("[registry] Set OTACON_SERVICE_MODE=registry|admin for split mode");

            // Build full router with all routes, no auth middleware
            let all_routes = axum::Router::new()
                .route("/", axum::routing::get(|| async {
                    axum::response::Html(include_str!("../static/index.html"))
                }))
                .route("/api/v1/hosts/register", axum::routing::post(api::hosts::register))
                .route("/api/v1/hosts/heartbeat", axum::routing::post(api::hosts::heartbeat))
                .route("/api/v1/hosts", axum::routing::get(api::hosts::list))
                .route("/api/v1/hosts/{id}", axum::routing::get(api::hosts::get))
                .route("/api/v1/phones", axum::routing::get(api::phones::list))
                .route("/api/v1/phones/{id}", axum::routing::get(api::phones::get).patch(api::phones::update))
                .route("/api/v1/phones/{id}/location", axum::routing::get(api::phones::location))
                .route("/api/v1/phones/register", axum::routing::post(api::phones::register))
                .route("/api/v1/phones/deregister", axum::routing::post(api::phones::deregister))
                .route("/api/v1/phones/{id}/config", axum::routing::get(api::phones::get_config).put(api::phones::set_config))
                .route("/api/v1/sims", axum::routing::get(api::sims::list))
                .route("/api/v1/phones/{id}/sims", axum::routing::get(api::sims::list_for_phone).post(api::sims::report))
                .route("/api/v1/dongles", axum::routing::get(api::dongles::list))
                .route("/api/v1/dongles/register", axum::routing::post(api::dongles::register))
                .route("/api/v1/events", axum::routing::get(api::events::list).post(api::events::report))
                .route("/ws/host/config", axum::routing::get(ws::host_config_ws))
                .route("/ws/fleet/events", axum::routing::get(ws::fleet_events_ws))
                .with_state(app_state)
                .layer(CorsLayer::permissive());
            all_routes
        }
    };

    let addr = format!("0.0.0.0:{port}");
    eprintln!("[registry] Listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
