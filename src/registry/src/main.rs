use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

mod api;
mod store;

#[tokio::main]
async fn main() {
    let data_dir = std::env::var("REGISTRY_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".otacon").join("registry")
        });

    eprintln!("[registry] Data directory: {}", data_dir.display());
    let store = Arc::new(store::RegistryStore::load(&data_dir).await);

    let app = api::router(store)
        .layer(CorsLayer::permissive());

    let port: u16 = std::env::var("REGISTRY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let addr = format!("0.0.0.0:{port}");
    eprintln!("[registry] Listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
