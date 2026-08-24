//! How the daemon renders a refusal. Every route answers failure in one of
//! these shapes, so a client can branch on `code` rather than on prose.

use crate::runtime::RuntimeMutationError;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use nomoreide_daemon_client::protocol::{DaemonErrorCode, ErrorEnvelope, MutationErrorEnvelope};

/// The answer to a path no route claimed.
///
/// HTML, not the JSON envelope every *route* answers failure with. The
/// reference's dispatcher ends its loop with `sendHtml(response, "Not found",
/// 404)`, and this is the one 404 a browser can reach by typing a URL. The
/// envelope invariant is about routes; an unmatched path is not one, and the
/// daemon client already falls back to its own wording when a body is not an
/// envelope.
pub(crate) async fn unmatched() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("text/html; charset=utf-8"),
        )],
        "Not found",
    )
        .into_response()
}

pub(crate) async fn method_not_allowed() -> Response {
    error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed")
}

pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ErrorEnvelope {
            ok: false,
            error: message.to_string(),
        }),
    )
        .into_response()
}

pub(crate) fn mutation_error(error: RuntimeMutationError) -> Response {
    let (status, code, message, conflict) = match error {
        RuntimeMutationError::ServiceNotFound(name) => (
            StatusCode::NOT_FOUND,
            DaemonErrorCode::ServiceNotFound,
            format!("Service \"{name}\" is not registered."),
            None,
        ),
        RuntimeMutationError::UnsupportedServiceKind => (
            StatusCode::UNPROCESSABLE_ENTITY,
            DaemonErrorCode::UnsupportedServiceKind,
            "Only local, ssh, and docker-compose services are supported by the native daemon."
                .to_string(),
            None,
        ),
        RuntimeMutationError::PortConflict { message, conflict } => (
            StatusCode::CONFLICT,
            DaemonErrorCode::PortInUse,
            message,
            Some(*conflict),
        ),
        RuntimeMutationError::DaemonDraining => (
            StatusCode::SERVICE_UNAVAILABLE,
            DaemonErrorCode::DaemonDraining,
            "The daemon is draining process mutations.".to_string(),
            None,
        ),
        RuntimeMutationError::DaemonCleanupFailed => (
            StatusCode::SERVICE_UNAVAILABLE,
            DaemonErrorCode::DaemonCleanupFailed,
            "The daemon previously failed to clean up its services; new starts are disabled."
                .to_string(),
            None,
        ),
        RuntimeMutationError::ConfigLoadFailed => (
            StatusCode::INTERNAL_SERVER_ERROR,
            DaemonErrorCode::ConfigLoadFailed,
            "Failed to load NoMoreIDE config.".to_string(),
            None,
        ),
        RuntimeMutationError::ServiceStartFailed => (
            StatusCode::INTERNAL_SERVER_ERROR,
            DaemonErrorCode::ServiceStartFailed,
            "Failed to start the registered service.".to_string(),
            None,
        ),
        RuntimeMutationError::BundleNotFound(name) => (
            StatusCode::NOT_FOUND,
            DaemonErrorCode::BundleNotFound,
            format!("Bundle \"{name}\" is not registered."),
            None,
        ),
        RuntimeMutationError::DependencyCycle(message) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            DaemonErrorCode::DependencyCycle,
            message,
            None,
        ),
        RuntimeMutationError::CleanupFailed => (
            StatusCode::INTERNAL_SERVER_ERROR,
            DaemonErrorCode::CleanupFailed,
            "Failed to confirm service cleanup.".to_string(),
            None,
        ),
    };
    (
        status,
        Json(MutationErrorEnvelope {
            ok: false,
            error: message,
            code,
            conflict,
        }),
    )
        .into_response()
}
