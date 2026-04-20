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

    eprintln!("[registry] Data directory: {}", data_dir.display());

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

    let app_state = api::AppState {
        store: store.clone(),
        auth_store: auth_store.clone(),
        registration_store: registration_store.clone(),
    };

    eprintln!("[registry] Starting unified registry (port {port})");
    let app = api::build_router(app_state).layer(CorsLayer::permissive());

    let addr = format!("0.0.0.0:{port}");
    eprintln!("[registry] Listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
