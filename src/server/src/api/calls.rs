//! REST call control. Same controller and checks as `ws/voice/control`
//! (docs/voice-ws.md); state changes show up on the voice sockets and
//! /ws/events.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use utoipa::ToSchema;

use super::adb::adb_shell;
use crate::phone::PhoneState;
use crate::voice::table::Call;
use crate::voice::{CmdError, Command};

#[derive(Deserialize, Serialize, ToSchema)]
pub struct DialBody {
    /// Number to call, E.164 (e.g. +15551234567)
    #[serde(alias = "number")]
    pub to: String,
}

#[derive(Deserialize, Serialize, ToSchema, Default)]
pub struct CallTarget {
    /// Call id; defaults to the obvious call (see docs/voice-ws.md)
    pub call: Option<String>,
}

#[derive(Deserialize, Serialize, ToSchema)]
pub struct DtmfBody {
    /// Keypad digits: 0-9 * # A-D; `w` waits 500 ms
    pub digits: String,
}

/// Result of a call command (the socket's `ack.result`, plus `ok`).
#[derive(Serialize, ToSchema)]
pub struct CommandResponse {
    pub ok: bool,
    /// The new or answered call (dial, answer)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call: Option<Call>,
    /// All calls after the command (hold, resume, swap, merge)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calls: Option<Vec<Call>>,
    /// Digits sent (dtmf)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digits: Option<String>,
    /// Set to `adb` when the Bluetooth control link was down and the command
    /// was done with ADB instead (dial, answer, hangup only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct HfpInfo {
    /// The phone's Bluetooth control link is up
    pub connected: bool,
    /// The phone's AT+CHLD options (which of hold/swap/merge it supports)
    pub chld: Vec<String>,
}

#[derive(Serialize, ToSchema)]
pub struct CallsResponse {
    pub calls: Vec<Call>,
    pub hfp: HfpInfo,
}

#[derive(Serialize, ToSchema)]
pub struct CallErrorResponse {
    /// bad_request, invalid_state, unsupported, hfp_unavailable, phone_error or timeout
    pub error: String,
    pub message: String,
}

pub struct CallError(CmdError);

impl IntoResponse for CallError {
    fn into_response(self) -> Response {
        let status = match self.0.code {
            "bad_request" => StatusCode::BAD_REQUEST,
            "invalid_state" => StatusCode::CONFLICT,
            "unsupported" => StatusCode::UNPROCESSABLE_ENTITY,
            "hfp_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            "phone_error" => StatusCode::BAD_GATEWAY,
            "timeout" => StatusCode::GATEWAY_TIMEOUT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({"error": self.0.code, "message": self.0.message}))).into_response()
    }
}

type CallResult = Result<Json<CommandResponse>, CallError>;

async fn run(state: &PhoneState, cmd: Command) -> Result<CommandResponse, CmdError> {
    match state.voice.execute(cmd.clone()).await {
        Ok(v) => Ok(CommandResponse {
            ok: true,
            call: v.get("call").and_then(|c| serde_json::from_value(c.clone()).ok()),
            calls: v.get("calls").and_then(|c| serde_json::from_value(c.clone()).ok()),
            digits: v.get("digits").and_then(|d| d.as_str()).map(String::from),
            fallback: None,
        }),
        Err(e)
            if e.code == "hfp_unavailable"
                && matches!(cmd, Command::Dial { .. } | Command::Answer { .. } | Command::Hangup { .. }) =>
        {
            adb_fallback(state, &cmd).await
        }
        Err(e) => Err(e),
    }
}

/// Today's ADB behaviour, for when the phone's Bluetooth control link is down.
async fn adb_fallback(state: &PhoneState, cmd: &Command) -> Result<CommandResponse, CmdError> {
    let serial = &state.config.adb_serial;
    let shell = match cmd {
        Command::Dial { to } => {
            let to: String = to.chars().filter(|c| !matches!(c, ' ' | '-' | '(' | ')' | '.')).collect();
            if to.is_empty() || !to.chars().all(|c| c.is_ascii_digit() || c == '+' || c == '*' || c == '#') {
                return Err(CmdError::new("bad_request", "`to` must be a phone number"));
            }
            format!("am start -a android.intent.action.CALL -d 'tel:{}'", to.replace('#', "%23"))
        }
        Command::Answer { .. } => "input keyevent KEYCODE_CALL".to_string(),
        Command::Hangup { .. } => "input keyevent KEYCODE_ENDCALL".to_string(),
        _ => unreachable!(),
    };
    adb_shell(serial, &shell)
        .await
        .map_err(|e| CmdError::new("phone_error", format!("adb: {e:?}")))?;
    Ok(CommandResponse { ok: true, call: None, calls: None, digits: None, fallback: Some("adb".into()) })
}

macro_rules! command_handler {
    ($fn:ident, $path:literal, $op:literal, $doc:literal) => {
        #[doc = $doc]
        #[utoipa::path(
            post,
            path = $path,
            tag = "Calls",
            operation_id = $op,
            responses(
                (status = 200, body = CommandResponse),
                (status = 409, body = CallErrorResponse, description = "invalid_state"),
                (status = 422, body = CallErrorResponse, description = "unsupported"),
                (status = 502, body = CallErrorResponse, description = "phone_error"),
                (status = 503, body = CallErrorResponse, description = "hfp_unavailable"),
                (status = 504, body = CallErrorResponse, description = "timeout"),
            )
        )]
        pub async fn $fn(state: Arc<PhoneState>) -> CallResult {
            run(&state, command_for($op, None)).await.map(Json).map_err(CallError)
        }
    };
}

fn command_for(op: &str, call: Option<String>) -> Command {
    match op {
        "holdCall" => Command::Hold,
        "resumeCall" => Command::Resume,
        "swapCalls" => Command::Swap,
        "mergeCalls" => Command::Merge,
        "answerCall" => Command::Answer { call },
        "rejectCall" => Command::Reject { call },
        "hangupCall" => Command::Hangup { call },
        _ => unreachable!(),
    }
}

command_handler!(hold_handler, "/api/calls/hold", "holdCall", "Put the active call on hold");
command_handler!(resume_handler, "/api/calls/resume", "resumeCall", "Make the held call active");
command_handler!(swap_handler, "/api/calls/swap", "swapCalls", "Swap the active and held calls");
command_handler!(merge_handler, "/api/calls/merge", "mergeCalls", "Merge the active and held calls");

macro_rules! target_handler {
    ($fn:ident, $path:literal, $op:literal, $doc:literal) => {
        #[doc = $doc]
        #[utoipa::path(
            post,
            path = $path,
            tag = "Calls",
            operation_id = $op,
            request_body(content = CallTarget, description = "Optional; an empty body is fine"),
            responses(
                (status = 200, body = CommandResponse),
                (status = 409, body = CallErrorResponse, description = "invalid_state"),
                (status = 422, body = CallErrorResponse, description = "unsupported"),
                (status = 502, body = CallErrorResponse, description = "phone_error"),
                (status = 503, body = CallErrorResponse, description = "hfp_unavailable"),
                (status = 504, body = CallErrorResponse, description = "timeout"),
            )
        )]
        pub async fn $fn(state: Arc<PhoneState>, body: Option<Json<CallTarget>>) -> CallResult {
            let call = body.and_then(|b| b.0.call);
            run(&state, command_for($op, call)).await.map(Json).map_err(CallError)
        }
    };
}

target_handler!(answer_handler, "/api/calls/answer", "answerCall", "Answer the ringing call");
target_handler!(reject_handler, "/api/calls/reject", "rejectCall", "Decline the ringing call");
target_handler!(hangup_handler, "/api/calls/hangup", "hangupCall", "End a call (default: the active call)");

#[utoipa::path(
    post,
    path = "/api/calls/dial",
    tag = "Calls",
    operation_id = "dialCall",
    request_body = DialBody,
    responses(
        (status = 200, body = CommandResponse),
        (status = 400, body = CallErrorResponse, description = "bad_request"),
        (status = 409, body = CallErrorResponse, description = "invalid_state"),
        (status = 502, body = CallErrorResponse, description = "phone_error"),
        (status = 503, body = CallErrorResponse, description = "hfp_unavailable"),
        (status = 504, body = CallErrorResponse, description = "timeout"),
    )
)]
pub async fn dial_handler(state: Arc<PhoneState>, Json(body): Json<DialBody>) -> CallResult {
    run(&state, Command::Dial { to: body.to }).await.map(Json).map_err(CallError)
}

#[utoipa::path(
    post,
    path = "/api/calls/dtmf",
    tag = "Calls",
    operation_id = "sendDtmf",
    request_body = DtmfBody,
    responses(
        (status = 200, body = CommandResponse),
        (status = 400, body = CallErrorResponse, description = "bad_request"),
        (status = 409, body = CallErrorResponse, description = "invalid_state"),
        (status = 502, body = CallErrorResponse, description = "phone_error"),
        (status = 503, body = CallErrorResponse, description = "hfp_unavailable"),
        (status = 504, body = CallErrorResponse, description = "timeout"),
    )
)]
pub async fn dtmf_handler(state: Arc<PhoneState>, Json(body): Json<DtmfBody>) -> CallResult {
    run(&state, Command::Dtmf { digits: body.digits }).await.map(Json).map_err(CallError)
}

#[utoipa::path(
    get,
    path = "/api/calls/status",
    tag = "Calls",
    operation_id = "getCallStatus",
    responses((status = 200, body = CallsResponse))
)]
pub async fn status_handler(state: Arc<PhoneState>) -> Result<Json<CallsResponse>, CallError> {
    // Re-read from the phone when HFP is up; otherwise the last known calls
    // (from the kiosk's call watcher).
    state.voice.execute(Command::Status).await.map_err(CallError)?;
    let hfp = state.voice.hfp_json();
    Ok(Json(CallsResponse {
        calls: state.voice.calls(),
        hfp: HfpInfo {
            connected: hfp["connected"].as_bool().unwrap_or(false),
            chld: serde_json::from_value(hfp["chld"].clone()).unwrap_or_default(),
        },
    }))
}
