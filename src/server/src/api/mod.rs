pub mod adb;
pub mod action;
pub mod apps;
pub mod bridge;
pub mod calls;
pub mod clipboard;
pub mod contacts;
pub mod device;
pub mod esim;
pub mod factory_reset;
pub mod open;
pub mod phones;
pub mod record;
pub mod screenshot;
pub mod sms;
pub mod snapshot;
pub mod internal;
pub mod test_sim;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Serialize;
use std::sync::Arc;
use utoipa::{OpenApi, ToSchema};

use crate::AppState;
use crate::phone::PhoneState;

#[derive(Serialize, ToSchema)]
pub struct OkResponse {
    pub ok: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug)]
pub enum ApiError {
    Adb(String),
    BadRequest(String),
    NotFound(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::Adb(msg) => (StatusCode::BAD_GATEWAY, msg),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Otacon Phone Automation API",
        description = "REST API for controlling Android phones connected to a Raspberry Pi.",
        version = "2.0.0",
        license(name = "MIT"),
    ),
    servers(
        (url = "https://otacon-pi:8080", description = "Default Tailscale address"),
    ),
    paths(
        action::handler,
        screenshot::handler,
        snapshot::handler,
        device::info_handler,
        device::notifications_handler,
        device::dismiss_notification_handler,
        device::notification_action_handler,
        clipboard::get_handler,
        clipboard::set_handler,
        sms::threads_handler,
        sms::messages_handler,
        sms::send_handler,
        contacts::handler,
        apps::list_handler,
        apps::running_handler,
        apps::launch_handler,
        apps::stop_handler,
        apps::install_handler,
        open::handler,
        record::start_handler,
        record::stop_handler,
        record::status_handler,
        calls::dial_handler,
        calls::answer_handler,
        calls::hangup_handler,
        calls::status_handler,
    ),
    components(schemas(
        action::Action, action::TapParams, action::SwipeParams, action::PinchParams,
        action::KeyParams, action::TypeParams, action::SetTextParams, action::ScrollParams,
        snapshot::A11yNode, snapshot::Bounds,
        device::DeviceInfo, device::Notification, device::NotificationAction,
        sms::SmsThread, sms::SmsMessage, sms::SendSmsBody,
        clipboard::ClipboardContent, clipboard::SetClipboardBody,
        apps::App, apps::LaunchBody,
        contacts::Contact,
        open::OpenBody,
        record::StartRecordBody, record::RecordStatus,
        calls::DialBody, calls::CallStatus,
        OkResponse, ErrorResponse,
    ))
)]
pub struct ApiDoc;

/// Extract a PhoneState from the AppState phone map using the path parameter.
async fn extract_phone(
    State(state): State<Arc<AppState>>,
    Path(phone_id): Path<String>,
) -> Result<Arc<PhoneState>, ApiError> {
    state.phones.read().await
        .get(&phone_id)
        .cloned()
        .ok_or_else(|| ApiError::NotFound(format!("phone '{phone_id}' not found")))
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        // Static UI
        .route("/", get(index_handler))
        // Phone management
        .route("/phones", get(phones::list).post(phones::register))
        .route("/phones/{id}", get(phones::get).delete(phones::remove))
        // Per-phone API: all endpoints nested under /phones/{id}/
        .route("/phones/{id}/api/action", post(phone_action))
        .route("/phones/{id}/api/screenshot", get(phone_screenshot))
        .route("/phones/{id}/api/snapshot", get(phone_snapshot))
        .route("/phones/{id}/api/info", get(phone_info))
        .route("/phones/{id}/api/notifications", get(phone_notifications))
        .route("/phones/{id}/api/notifications/{key}", delete(phone_dismiss_notification))
        .route("/phones/{id}/api/notifications/{key}/action/{index}", post(phone_notification_action))
        .route("/phones/{id}/api/clipboard", get(phone_clipboard_get).put(phone_clipboard_set))
        .route("/phones/{id}/api/sms/threads", get(phone_sms_threads))
        .route("/phones/{id}/api/sms/threads/{thread_id}/messages", get(phone_sms_messages))
        .route("/phones/{id}/api/sms/messages", post(phone_sms_send))
        .route("/phones/{id}/api/calls/dial", post(phone_calls_dial))
        .route("/phones/{id}/api/calls/answer", post(phone_calls_answer))
        .route("/phones/{id}/api/calls/hangup", post(phone_calls_hangup))
        .route("/phones/{id}/api/calls/status", get(phone_calls_status))
        .route("/phones/{id}/api/contacts", get(phone_contacts))
        .route("/phones/{id}/api/apps", get(phone_apps_list))
        .route("/phones/{id}/api/apps/running", get(phone_apps_running).post(phone_apps_launch))
        .route("/phones/{id}/api/apps/running/{package}", delete(phone_apps_stop))
        .route("/phones/{id}/api/apps/install", post(phone_apps_install)
            .layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024)))
        .route("/phones/{id}/api/esim/profiles", get(phone_esim_profiles))
        .route("/phones/{id}/api/esim/install", post(phone_esim_install))
        .route("/phones/{id}/api/esim/delete", post(phone_esim_delete))
        .route("/phones/{id}/api/esim/switch", post(phone_esim_switch))
        .route("/phones/{id}/api/esim/enable", post(phone_esim_enable))
        .route("/phones/{id}/api/esim/defaults", get(phone_esim_defaults_get).put(phone_esim_defaults_set))
        .route("/phones/{id}/api/factory-reset", post(phone_factory_reset))
        .route("/phones/{id}/api/open", post(phone_open))
        .route("/phones/{id}/api/record/start", post(phone_record_start))
        .route("/phones/{id}/api/record/stop", post(phone_record_stop))
        .route("/phones/{id}/api/record/status", get(phone_record_status))
        .route("/phones/{id}/api/test/call/incoming", post(phone_test_incoming))
        .route("/phones/{id}/api/test/call/connect", post(phone_test_connect))
        .route("/phones/{id}/api/test/call/end", post(phone_test_end))
        .route("/phones/{id}/api/test/sms/receive", post(phone_test_sms))
        .route("/phones/{id}/api/internal/event", post(phone_internal_event))
        // Per-phone WebSocket endpoints
        .route("/phones/{id}/ws/audio/call", get(phone_ws_call))
        .route("/phones/{id}/ws/audio/media", get(phone_ws_media))
        .route("/phones/{id}/ws/events", get(phone_ws_events))
        .route("/phones/{id}/ws/record", get(phone_ws_record))
        .route("/phones/{id}/audio", get(phone_mp3))
        // System-level
        .route("/ws/system/events", get(system_events_ws))
        // OpenAPI spec
        .route("/api/docs/openapi.json", get(|| async {
            let spec = ApiDoc::openapi().to_json().unwrap();
            ([("content-type", "application/json")], spec)
        }))
        .with_state(state)
}

/// Serve the monitoring UI
async fn index_handler() -> Html<&'static str> {
    Html(include_str!("../../static/index.html"))
}

// --- Per-phone handler wrappers ---
// Each extracts PhoneState from the phone map and delegates to the actual handler.

async fn phone_action(
    State(state): State<Arc<AppState>>, Path(id): Path<String>, body: Json<action::Action>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    action::handler(ps, body).await
}

async fn phone_screenshot(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    screenshot::handler(&ps.config.adb_serial).await
}

async fn phone_snapshot(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    query: axum::extract::Query<snapshot::SnapshotQuery>,
) -> Result<Response, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    snapshot::handler(ps, query).await
}

async fn phone_info(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<device::DeviceInfo>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    device::info_handler(ps).await
}

async fn phone_notifications(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<Vec<device::Notification>>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    device::notifications_handler(ps).await
}

async fn phone_dismiss_notification(
    State(state): State<Arc<AppState>>, Path((id, key)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    device::dismiss_notification_handler(ps, Path(key)).await
}

async fn phone_notification_action(
    State(state): State<Arc<AppState>>, Path((id, key, index)): Path<(String, String, u32)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    device::notification_action_handler(ps, Path((key, index))).await
}

async fn phone_clipboard_get(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<clipboard::ClipboardContent>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    clipboard::get_handler(ps).await
}

async fn phone_clipboard_set(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<clipboard::SetClipboardBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    clipboard::set_handler(ps, body).await
}

async fn phone_sms_threads(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<Vec<sms::SmsThread>>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    sms::threads_handler(&ps.config.adb_serial).await
}

async fn phone_sms_messages(
    State(state): State<Arc<AppState>>, Path((id, thread_id)): Path<(String, String)>,
) -> Result<Json<Vec<sms::SmsMessage>>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    sms::messages_handler(&ps.config.adb_serial, Path(thread_id)).await
}

async fn phone_sms_send(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<sms::SendSmsBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    sms::send_handler(ps, body).await
}

async fn phone_calls_dial(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<calls::DialBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    calls::dial_handler(ps, body).await
}

async fn phone_calls_answer(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    calls::answer_handler(ps).await
}

async fn phone_calls_hangup(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    calls::hangup_handler(ps).await
}

async fn phone_calls_status(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<calls::CallStatus>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    calls::status_handler(ps).await
}

async fn phone_contacts(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    query: axum::extract::Query<contacts::ContactsQuery>,
) -> Result<Json<Vec<contacts::Contact>>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    contacts::handler(&ps.config.adb_serial, query).await
}

async fn phone_apps_list(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<Vec<apps::App>>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    apps::list_handler(&ps.config.adb_serial).await
}

async fn phone_apps_running(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<Vec<apps::App>>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    apps::running_handler(&ps.config.adb_serial).await
}

async fn phone_apps_launch(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<apps::LaunchBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    apps::launch_handler(&ps.config.adb_serial, body).await
}

async fn phone_apps_stop(
    State(state): State<Arc<AppState>>, Path((id, package)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    apps::stop_handler(&ps.config.adb_serial, Path(package)).await
}

async fn phone_apps_install(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    apps::install_handler(&ps.config.adb_serial, body).await
}

async fn phone_esim_profiles(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<Vec<esim::EsimProfile>>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    esim::profiles_handler(ps).await
}

async fn phone_esim_install(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<esim::InstallBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    esim::install_handler(&ps.config.adb_serial, body).await
}

async fn phone_esim_delete(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<esim::DeleteBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    esim::delete_handler(&ps.config.adb_serial, body).await
}

async fn phone_esim_switch(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<esim::SwitchBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    esim::switch_handler(ps, body).await
}

async fn phone_esim_enable(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<esim::EnableBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    esim::enable_handler(ps, body).await
}

async fn phone_esim_defaults_get(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<esim::EsimDefaults>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    esim::defaults_get_handler(&ps.config.adb_serial).await
}

async fn phone_esim_defaults_set(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<esim::SetDefaultsBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    esim::defaults_set_handler(&ps.config.adb_serial, body).await
}

async fn phone_factory_reset(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<factory_reset::FactoryResetBody>,
) -> Result<(axum::http::StatusCode, Json<factory_reset::FactoryResetResponse>), ApiError> {
    let ps = extract_phone(State(state.clone()), Path(id.clone())).await?;
    factory_reset::handler(ps, id, body).await
}

async fn phone_open(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<open::OpenBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    open::handler(&ps.config.adb_serial, body).await
}

async fn phone_record_start(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<record::StartRecordBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let ps = extract_phone(State(state), Path(id)).await
        .map_err(|e| e.into_response())?;
    record::start_handler(ps, body).await
}

async fn phone_record_stop(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Response, Response> {
    let ps = extract_phone(State(state), Path(id)).await
        .map_err(|e| e.into_response())?;
    record::stop_handler(ps).await
}

async fn phone_record_status(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<record::RecordStatus>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    Ok(record::status_handler(ps).await)
}

async fn phone_test_incoming(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<test_sim::SimIncomingBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    test_sim::sim_incoming(ps, body).await
}

async fn phone_test_connect(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    test_sim::sim_connect(ps).await
}

async fn phone_test_end(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<test_sim::SimEndBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    test_sim::sim_end(ps, body).await
}

async fn phone_test_sms(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<test_sim::SimSmsBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    test_sim::sim_sms_receive(ps, body).await
}

async fn phone_internal_event(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    body: Json<internal::DeviceEvent>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    Ok(internal::event_handler(ps, body).await)
}

// --- Per-phone WebSocket handlers ---

async fn phone_ws_call(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    ws: axum::extract::ws::WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    Ok(crate::ws_handler(ws, ps).await)
}

async fn phone_ws_media(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    ws: axum::extract::ws::WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    Ok(crate::ws_media_handler(ws, ps).await)
}

async fn phone_ws_events(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    ws: axum::extract::ws::WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    Ok(crate::ws_events_handler(ws, ps).await)
}

async fn phone_ws_record(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
    ws: axum::extract::ws::WebSocketUpgrade,
    query: axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    let max_duration: u32 = query.0.get("max_duration")
        .and_then(|v| v.parse().ok())
        .unwrap_or(30)
        .min(180);
    Ok(ws.on_upgrade(move |socket| crate::handle_ws_record(socket, ps, max_duration)))
}

async fn phone_mp3(
    State(state): State<Arc<AppState>>, Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let ps = extract_phone(State(state), Path(id)).await?;
    Ok(crate::mp3_stream_handler(ps.audio_config.mp3_cmd.clone()).await)
}

// --- System-level WebSocket ---

async fn system_events_ws(
    State(state): State<Arc<AppState>>,
    ws: axum::extract::ws::WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| handle_system_events(socket, state))
}

async fn handle_system_events(
    socket: axum::extract::ws::WebSocket,
    state: Arc<AppState>,
) {
    use futures::SinkExt;
    let (mut ws_tx, mut ws_rx) = futures::StreamExt::split(socket);
    let mut rx = state.system_events_tx.subscribe();

    let send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event_json) => {
                    if ws_tx.send(axum::extract::ws::Message::Text(event_json.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("System events client lagged, skipped {n} messages");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let drain_task = tokio::spawn(async move {
        use futures::StreamExt;
        while let Some(Ok(msg)) = ws_rx.next().await {
            if matches!(msg, axum::extract::ws::Message::Close(_)) {
                break;
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = drain_task => {},
    }
}
