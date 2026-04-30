use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

mod api;
mod auth;
mod ingestion;
mod store;
mod ws;

#[tokio::main]
async fn main() {
    // --export-openapi: dump the OpenAPI spec and exit (no data dir or auth needed)
    if std::env::args().any(|a| a == "--export-openapi") {
        use utoipa::OpenApi;
        let spec = api::ApiDoc::openapi().to_pretty_json().unwrap();
        println!("{spec}");
        return;
    }

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

    // Bootstrap: if no admin tokens exist, either seed from
    // REGISTRY_BOOTSTRAP_ADMIN_TOKEN (deterministic) or generate a random
    // token and print it once (legacy behavior).
    if !auth_store.has_admin_tokens().await {
        if let Ok(seeded) = std::env::var("REGISTRY_BOOTSTRAP_ADMIN_TOKEN") {
            let token_id = auth_store
                .insert_token_with_value(
                    seeded,
                    auth::AuthScope::Admin,
                    None,
                    Some("Bootstrap admin token (seeded)".into()),
                )
                .await
                .expect("REGISTRY_BOOTSTRAP_ADMIN_TOKEN invalid");
            eprintln!(
                "[registry] Seeded admin token from REGISTRY_BOOTSTRAP_ADMIN_TOKEN (id: {token_id})"
            );
        } else {
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
