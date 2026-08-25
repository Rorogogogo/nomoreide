//! How the daemon renders a refusal.
//!
//! Every shape here is the reference's, including the ones that look like
//! oversights. A refusal a route did not catch is a 500 with prose in it, and
//! that is the contract: the dashboard reads `error`, and the only structured
//! failure either runtime offers is a port conflict.

use crate::runtime::RuntimeMutationError;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use nomoreide_daemon_client::protocol::{ErrorEnvelope, MutationErrorEnvelope};

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

/// The status the reference's dispatcher would give a config-store failure:
/// 400 when the caller can fix it, 500 otherwise. These routes have no error
/// branch of their own, so the split is entirely in what was thrown.
pub(crate) fn config_failure(reason: &anyhow::Error) -> Response {
    let status = if nomoreide_core::config::is_config_validation_error(reason) {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    error(status, &reason.to_string())
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

/// Render a runtime refusal the way the reference's routes do.
///
/// There are exactly **two** shapes, and the split is not semantic — it is
/// structural. The reference's service route catches `PortConflictError` and
/// nothing else; its bundle route catches nothing at all. So a port conflict is
/// a **409** carrying the conflict, and every other failure — an unregistered
/// service, an unknown bundle, a dependency cycle, a daemon that is draining —
/// escapes to the dispatcher and becomes a plain **500**.
///
/// It is tempting to answer 404 for a name that is not registered and 503 for a
/// draining daemon, and this daemon used to. But the dashboard is the
/// reference's dashboard: it reads the message, not the status, and a client
/// that started branching on the richer statuses would be reading a contract
/// only one of the two runtimes offers.
pub(crate) fn mutation_error(failure: RuntimeMutationError) -> Response {
    if let RuntimeMutationError::PortConflict { message, conflict } = failure {
        return (
            StatusCode::CONFLICT,
            Json(MutationErrorEnvelope {
                ok: false,
                error: message,
                conflict: Some(*conflict),
            }),
        )
            .into_response();
    }
    let message = match failure {
        RuntimeMutationError::ServiceNotFound(name) => {
            format!("Service \"{name}\" is not registered.")
        }
        RuntimeMutationError::BundleNotFound(name) => {
            format!("Bundle \"{name}\" is not registered.")
        }
        RuntimeMutationError::UnsupportedServiceKind => {
            "Only local, ssh, and docker-compose services are supported by the native daemon."
                .to_string()
        }
        RuntimeMutationError::DaemonDraining => {
            "The daemon is draining process mutations.".to_string()
        }
        RuntimeMutationError::DaemonCleanupFailed => {
            "The daemon previously failed to clean up its services; new starts are disabled."
                .to_string()
        }
        RuntimeMutationError::ConfigLoadFailed => "Failed to load NoMoreIDE config.".to_string(),
        RuntimeMutationError::ServiceStartFailed => {
            "Failed to start the registered service.".to_string()
        }
        RuntimeMutationError::DependencyCycle(message) => message,
        RuntimeMutationError::CleanupFailed => "Failed to confirm service cleanup.".to_string(),
        RuntimeMutationError::PortConflict { .. } => unreachable!("handled above"),
    };
    error(StatusCode::INTERNAL_SERVER_ERROR, &message)
}
