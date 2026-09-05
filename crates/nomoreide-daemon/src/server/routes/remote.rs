//! What the local CLI asks about remote control.
//!
//! Two endpoints, both for `nomoreide remote`. Neither is reachable from a
//! phone: they are on the daemon's own loopback router behind the local
//! credential, which is a different surface entirely from the relay's.
//!
//! `connect` exists because pairing and connecting are separate events. A
//! machine paired while its daemon is already running used to stay offline
//! until something restarted it, with nothing saying so — so `remote pair` now
//! asks the daemon to dial the moment the credential is on disk.
//!
//! **Pairing itself is here too, so the dashboard can do it.** Requiring a
//! terminal for the one step that introduces the feature is a poor way to
//! introduce it — somebody who lives in the dashboard should not have to find a
//! shell to put their machine on their phone.
//!
//! The ticket that pairing mints stays *in the daemon*. Its `pairing_secret` is
//! a bearer token until it is exchanged, and a browser has no use for it: the
//! page needs the short code a human types and nothing else. So `start` keeps
//! the ticket in memory and hands back only what is meant to be read aloud, and
//! `poll` completes the exchange against the ticket the daemon already holds.

use crate::server::app::AppState;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/remote/status", get(status))
        .route("/api/remote/connect", post(connect))
        .route("/api/remote/pair", post(start_pairing).delete(unpair))
        .route("/api/remote/pair/poll", post(poll_pairing))
}

/// The pairing this daemon has in flight, if any.
///
/// One at a time: a second `start` replaces the first, because two live codes
/// for one machine is a way to pair it twice and leave an orphan device on
/// somebody's account.
#[derive(Clone, Default)]
pub(crate) struct PendingPairing(
    std::sync::Arc<std::sync::Mutex<Option<nomoreide_core::remote::pairing::PairingTicket>>>,
);

impl PendingPairing {
    fn put(&self, ticket: nomoreide_core::remote::pairing::PairingTicket) {
        *self.0.lock().unwrap() = Some(ticket);
    }

    fn get(&self) -> Option<nomoreide_core::remote::pairing::PairingTicket> {
        self.0.lock().unwrap().clone()
    }

    fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
}

/// Begin pairing, and hand back only what a human reads.
async fn start_pairing(State(state): State<AppState>) -> Response {
    use nomoreide_core::remote::pairing::{DeviceProposal, PairingFlow};

    let flow = PairingFlow::discover();
    let proposal = DeviceProposal::for_this_machine(None);
    match flow.start(&proposal).await {
        Ok(ticket) => {
            state.pending_pairing.put(ticket.clone());
            Json(json!({
                "ok": true,
                "userCode": ticket.user_code,
                "verificationUrl": ticket.verification_url,
                // The module grid, not an image. The browser draws its own SVG
                // from it, the terminal draws half-blocks, and the encoding
                // happens once — see `nomoreide_core::remote::qr`. Absent when
                // the link would not fit a code, which costs the picture and
                // not the pairing.
                //
                // Encodes the *scan* URL, which carries the token that claims
                // this pairing with no account. That token never reaches the
                // browser as text: `verificationUrl` above is the typed link,
                // and only the picture holds the other one.
                "verificationQr": nomoreide_core::remote::qr::encode(ticket.qr_payload()),
                "expiresAt": ticket.expires_at,
                "deviceName": proposal.name,
            }))
            .into_response()
        }
        Err(error) => pairing_failure(error),
    }
}

/// Ask whether the code has been claimed, and finish if it has.
///
/// Completing here rather than in a separate call means the browser cannot end
/// up holding a claimed-but-unexchanged pairing, which is the state that leaves
/// a device row on an account with no credential on the machine.
async fn poll_pairing(State(state): State<AppState>) -> Response {
    use nomoreide_core::remote::pairing::{PairingFlow, PairingStatus};

    let Some(ticket) = state.pending_pairing.get() else {
        return Json(json!({ "ok": false, "status": "noPairingInProgress" })).into_response();
    };
    let flow = PairingFlow::discover();
    let progress = match flow.poll(&ticket).await {
        Ok(progress) => progress,
        Err(error) => return pairing_failure(error),
    };
    match progress.status {
        PairingStatus::Pending => Json(json!({ "ok": true, "status": "pending" })).into_response(),
        PairingStatus::Expired => {
            state.pending_pairing.clear();
            Json(json!({ "ok": false, "status": "expired" })).into_response()
        }
        PairingStatus::Claimed | PairingStatus::Exchanged => match flow.complete(&ticket).await {
            Ok(stored) => {
                state.pending_pairing.clear();
                // The same reason `remote pair` calls connect: pairing and
                // connecting are separate events, and a machine that pairs
                // without dialling looks broken from the phone.
                state.relay.ensure_started();
                Json(json!({
                    "ok": true,
                    "status": "paired",
                    "deviceName": stored.device_name,
                    "deviceId": stored.device_id,
                }))
                .into_response()
            }
            Err(error) => pairing_failure(error),
        },
    }
}

/// Forget this machine's credential.
///
/// Local only, and it says so: the device row stays on the account until it is
/// revoked from the phone. Deleting the file stops this machine connecting; it
/// does not withdraw anything, because revocation is the owner's to perform.
async fn unpair(State(state): State<AppState>) -> Response {
    state.pending_pairing.clear();
    match nomoreide_core::remote::credentials::RemoteCredentials::discover().clear() {
        Ok(had) => Json(json!({ "ok": true, "wasPaired": had })).into_response(),
        Err(error) => Json(json!({ "ok": false, "error": error.to_string() })).into_response(),
    }
}

fn pairing_failure(error: nomoreide_core::remote::pairing::PairingError) -> Response {
    Json(json!({ "ok": false, "status": "failed", "error": error.to_string() })).into_response()
}

/// Whether this machine is paired, and whether it is actually attached.
///
/// The two are reported separately on purpose. A credential on disk with
/// nothing connected is the state a freshly paired machine is in, and every
/// check that reads only the file calls it healthy.
async fn status(State(state): State<AppState>) -> Response {
    let paired = nomoreide_core::remote::credentials::RemoteCredentials::discover().load();
    let relay = state.relay.snapshot();
    Json(json!({
        "ok": true,
        "paired": paired.is_some(),
        "deviceName": paired.as_ref().map(|stored| stored.device_name.clone()),
        "deviceId": paired.as_ref().map(|stored| stored.device_id.clone()),
        "platformBaseUrl": paired.as_ref().map(|stored| stored.platform_base_url.clone()),
        "relay": relay,
    }))
    .into_response()
}

/// Start the relay connection now.
///
/// Idempotent: a second call while one is running is `alreadyRunning`, not a
/// second socket. The relay keeps only the newest connection per device, so a
/// duplicate would silently evict its own predecessor.
async fn connect(State(state): State<AppState>) -> Response {
    use crate::remote::supervisor::StartOutcome;
    let outcome = state.relay.ensure_started();
    let (ok, status) = match outcome {
        StartOutcome::Started => (true, "started"),
        StartOutcome::AlreadyRunning => (true, "alreadyRunning"),
        StartOutcome::NotPaired => (false, "notPaired"),
        StartOutcome::Disabled => (false, "disabled"),
    };
    Json(json!({ "ok": ok, "status": status })).into_response()
}
