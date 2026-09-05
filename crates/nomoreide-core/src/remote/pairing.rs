//! Pairing this machine with the hosted platform.
//!
//! The daemon's side of the three legs: it *starts* a pairing and is handed a
//! code to show the user, it *polls* until a signed-in human has claimed that
//! code, and only then does it *exchange* its secret for a lasting credential.
//!
//! Two properties are worth stating because they are easy to lose later.
//!
//! **Polling never carries the device credential**, because there is not one
//! yet — it carries the pairing secret, which dies with the pairing. So a
//! pairing that is abandoned halfway leaves nothing behind that can act.
//!
//! **The exchange is the only call that returns a credential, and it happens
//! once.** If the write to disk afterwards fails, the credential is gone and
//! the machine has to pair again — which is why [`PairingFlow::complete`] stores
//! before it reports success, rather than the other way round.

use crate::remote::credentials::{RemoteCredentials, StoredCredential};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// What the daemon proposes to be called, and what it can do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DeviceProposal {
    pub name: String,
    pub platform: String,
    pub daemon_version: String,
    pub protocol_version: i32,
}

impl DeviceProposal {
    /// This machine, as it would introduce itself.
    ///
    /// The name defaults to the hostname because it is the one string a user
    /// already associates with the machine in front of them. It is only a
    /// proposal: they see it before agreeing, and can rename it afterwards.
    pub fn for_this_machine(name: Option<String>) -> Self {
        Self {
            name: name.unwrap_or_else(default_device_name),
            platform: platform_name().to_string(),
            daemon_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: super::protocol::PROTOCOL_VERSION as i32,
        }
    }
}

/// `macos`, `linux`, `windows`, or whatever this was built for.
///
/// Coarse on purpose, and named rather than inlined so that stays true: an
/// exact kernel build is a fingerprint, and "macos" beside a machine name is
/// all the disambiguation a person holding a phone needs.
pub fn platform_name() -> &'static str {
    std::env::consts::OS
}

fn default_device_name() -> String {
    hostname().unwrap_or_else(|| "This machine".to_string())
}

/// The machine's own name, if it has one worth showing.
fn hostname() -> Option<String> {
    // No `hostname` crate, and none is worth adding for one string: every
    // platform this runs on sets one of these, and the fallback is a sentence
    // rather than a failure.
    for key in ["HOSTNAME", "COMPUTERNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    let output = std::process::Command::new("hostname").output().ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // A hostname like `studio.local` reads better as `studio`, and the suffix
    // says nothing a user needs.
    let name = name.split('.').next().unwrap_or(&name).to_string();
    (!name.is_empty()).then_some(name)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PairingTicket {
    pub session_id: String,
    pub pairing_secret: String,
    pub user_code: String,
    /// Where a signed-in person goes to claim this. Carries the short code and
    /// nothing else, because this is the one meant to be read aloud, printed
    /// in a terminal and typed.
    pub verification_url: String,
    /// The same page plus the scan token — **the QR payload, and only ever a
    /// QR payload.**
    ///
    /// The token is 32 random bytes in the URL's *fragment*, and it is what
    /// lets a phone claim this pairing with no account at all. That makes it a
    /// credential: it is never printed, never shown as text, and never what
    /// [`Self::verification_url`] resolves to. A fragment also never reaches an
    /// access log, a proxy or a `Referer`, which a query string does.
    ///
    /// `Option`, because a platform older than the scan flow does not send one
    /// — and a machine talking to one still pairs perfectly well by code. The
    /// QR falls back to the typed link, which is what it encoded before.
    #[serde(default)]
    pub scan_url: Option<String>,
    pub expires_at: String,
}

impl PairingTicket {
    /// What belongs in the QR code.
    ///
    /// The scan URL when the platform minted one, and the plain verification
    /// link otherwise. Both are pages that claim this pairing; only the first
    /// can do it without an account.
    pub fn qr_payload(&self) -> &str {
        self.scan_url.as_deref().unwrap_or(&self.verification_url)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairingStatus {
    Pending,
    Claimed,
    Exchanged,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PairingState {
    pub session_id: String,
    pub status: PairingStatus,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct IssuedCredential {
    pub device_id: String,
    pub credential: String,
    pub device_name: String,
}

#[derive(Debug)]
pub enum PairingError {
    /// The platform could not be reached at all.
    Unreachable(String),
    /// The platform answered, and said no.
    Refused { status: u16, message: String },
    /// The pairing ran out of time, or was abandoned.
    Expired,
    /// The credential arrived but could not be stored, so it is lost.
    NotStored(String),
}

impl std::fmt::Display for PairingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(detail) => {
                write!(formatter, "Could not reach the NoMoreIDE platform: {detail}")
            }
            Self::Refused { status, message } => {
                write!(formatter, "The platform refused the request ({status}): {message}")
            }
            Self::Expired => write!(
                formatter,
                "The pairing code expired before it was approved. Run `nomoreide remote pair` again."
            ),
            Self::NotStored(detail) => write!(
                formatter,
                "Paired, but the credential could not be saved ({detail}). Run `nomoreide remote pair` again."
            ),
        }
    }
}

impl std::error::Error for PairingError {}

/// How often the daemon asks whether a human has claimed the code yet.
///
/// Two seconds: fast enough that approving on a phone feels immediate, slow
/// enough that a ten-minute pairing is 300 requests rather than 6000.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The daemon's pairing client.
pub struct PairingFlow {
    base_url: String,
    http: reqwest::Client,
    credentials: RemoteCredentials,
}

impl PairingFlow {
    /// Against whichever platform this machine is configured for.
    ///
    /// Reuses the registry's own resolution — environment, then stored config,
    /// then the compiled-in default — so a developer pointed at a local stack
    /// pairs against it without a second setting to discover.
    pub fn discover() -> Self {
        Self::new(
            crate::agent_profiles::registry_config::api_base_url(),
            RemoteCredentials::discover(),
        )
    }

    pub fn new(base_url: String, credentials: RemoteCredentials) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
            credentials,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn credentials(&self) -> &RemoteCredentials {
        &self.credentials
    }

    /// Leg one. Returns the code to show the user.
    pub async fn start(&self, proposal: &DeviceProposal) -> Result<PairingTicket, PairingError> {
        let response = self
            .http
            .post(format!("{}/remote/pairing-sessions", self.base_url))
            .json(proposal)
            .send()
            .await
            .map_err(|error| PairingError::Unreachable(error.to_string()))?;
        parse(response).await
    }

    /// One poll. `Expired` here is a real answer, not an error.
    pub async fn poll(&self, ticket: &PairingTicket) -> Result<PairingState, PairingError> {
        let response = self
            .http
            .get(format!(
                "{}/remote/pairing-sessions/{}",
                self.base_url, ticket.session_id
            ))
            .bearer_auth(&ticket.pairing_secret)
            .send()
            .await
            .map_err(|error| PairingError::Unreachable(error.to_string()))?;
        parse(response).await
    }

    /// Leg three, and the write that has to succeed.
    ///
    /// The credential is stored *before* this returns. There is no second
    /// chance to fetch it, so a caller that reported success and then failed to
    /// save would leave the platform holding a device the machine cannot use.
    pub async fn complete(&self, ticket: &PairingTicket) -> Result<StoredCredential, PairingError> {
        let response = self
            .http
            .post(format!(
                "{}/remote/pairing-sessions/{}/exchange",
                self.base_url, ticket.session_id
            ))
            .bearer_auth(&ticket.pairing_secret)
            .send()
            .await
            .map_err(|error| PairingError::Unreachable(error.to_string()))?;
        let issued: IssuedCredential = parse(response).await?;

        let stored = StoredCredential {
            device_id: issued.device_id,
            device_name: issued.device_name,
            credential: issued.credential,
            platform_base_url: self.base_url.clone(),
            paired_at: chrono::Utc::now().to_rfc3339(),
        };
        self.credentials
            .store(&stored)
            .map_err(|error| PairingError::NotStored(error.to_string()))?;
        Ok(stored)
    }
}

/// Turn a response into `T`, or into the platform's own words.
///
/// The platform answers errors as `{"error":{"code","message"}}`. Surfacing its
/// `message` matters: "That pairing code is not valid" is something a user can
/// act on, and "HTTP 404" is not.
async fn parse<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, PairingError> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| PairingError::Unreachable(error.to_string()))?;
    if !status.is_success() {
        return Err(PairingError::Refused {
            status: status.as_u16(),
            message: platform_message(&body)
                .unwrap_or_else(|| body.trim().chars().take(200).collect()),
        });
    }
    serde_json::from_str(&body).map_err(|error| PairingError::Refused {
        status: status.as_u16(),
        message: format!("could not read the platform's answer: {error}"),
    })
}

fn platform_message(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("error")?
        .get("message")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_proposal_describes_this_build_and_this_platform() {
        let proposal = DeviceProposal::for_this_machine(Some("Studio".into()));

        assert_eq!(proposal.name, "Studio");
        assert_eq!(proposal.daemon_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(
            proposal.protocol_version,
            crate::remote::protocol::version::PROTOCOL_VERSION as i32
        );
        assert!(
            ["macos", "linux", "windows"].contains(&proposal.platform.as_str()),
            "{}",
            proposal.platform
        );
    }

    /// A machine with no name still pairs — it just proposes a sentence.
    #[test]
    fn a_proposal_always_has_a_name() {
        let proposal = DeviceProposal::for_this_machine(None);

        assert!(!proposal.name.trim().is_empty());
    }

    /// The platform speaks snake case; the device protocol speaks camel case.
    /// Sending the wrong one would be refused as a malformed body, which reads
    /// like a network problem rather than a mistake.
    #[test]
    fn a_proposal_serialises_in_the_platforms_case() {
        let json = serde_json::to_value(DeviceProposal::for_this_machine(Some("Studio".into())))
            .expect("serialize");

        assert!(json.get("daemon_version").is_some(), "{json}");
        assert!(json.get("protocol_version").is_some(), "{json}");
        assert!(json.get("daemonVersion").is_none(), "{json}");
    }

    #[test]
    fn a_ticket_parses_from_the_platforms_shape() {
        let ticket: PairingTicket = serde_json::from_str(
            r#"{
                "session_id": "11111111-2222-3333-4444-555555555555",
                "pairing_secret": "secret",
                "user_code": "ABCD-EFGH",
                "verification_url": "https://www.nomoreide.com/app/remote/pair?code=ABCD-EFGH",
                "expires_at": "2026-09-02T00:10:00Z"
            }"#,
        )
        .expect("parse");

        assert_eq!(ticket.user_code, "ABCD-EFGH");
        // A platform older than the scan flow sends no `scan_url`, and that
        // pairing still works — by code, the way it always did.
        assert_eq!(ticket.scan_url, None);
        assert_eq!(ticket.qr_payload(), ticket.verification_url);
    }

    /// The QR carries the scan URL when there is one, because that is the only
    /// one a phone can claim with no account. The typed link stays what it was.
    #[test]
    fn the_qr_payload_is_the_scan_url_when_the_platform_sends_one() {
        let ticket: PairingTicket = serde_json::from_str(
            r#"{
                "session_id": "11111111-2222-3333-4444-555555555555",
                "pairing_secret": "secret",
                "user_code": "ABCD-EFGH",
                "verification_url": "https://www.nomoreide.com/app/remote/pair?code=ABCD-EFGH",
                "scan_url": "https://www.nomoreide.com/app/remote/pair?code=ABCD-EFGH#t=abc",
                "expires_at": "2026-09-02T00:10:00Z"
            }"#,
        )
        .expect("parse");

        assert!(ticket.qr_payload().contains("#t=abc"));
        // ...and the token is *only* in the picture. The link a person reads
        // off a terminal, shares on a screen or types must not carry it.
        assert!(!ticket.verification_url.contains("#t="));
    }

    #[test]
    fn a_pairing_state_parses_every_status() {
        for (wire, expected) in [
            ("pending", PairingStatus::Pending),
            ("claimed", PairingStatus::Claimed),
            ("exchanged", PairingStatus::Exchanged),
            ("expired", PairingStatus::Expired),
        ] {
            let state: PairingState = serde_json::from_str(&format!(
                r#"{{"session_id":"s","status":"{wire}","expires_at":"2026-09-02T00:10:00Z"}}"#
            ))
            .unwrap_or_else(|error| panic!("{wire}: {error}"));
            assert_eq!(state.status, expected);
        }
    }

    /// The user should read the platform's sentence, not an HTTP status.
    #[test]
    fn a_refusal_surfaces_the_platforms_own_message() {
        let message = platform_message(
            r#"{"error":{"code":"NOT_FOUND","message":"That pairing code is not valid."}}"#,
        );

        assert_eq!(message.as_deref(), Some("That pairing code is not valid."));
    }

    #[test]
    fn a_body_that_is_not_an_error_envelope_has_no_message() {
        assert_eq!(platform_message("not json"), None);
        assert_eq!(platform_message("{}"), None);
        assert_eq!(platform_message(r#"{"error":"boom"}"#), None);
    }

    #[test]
    fn a_trailing_slash_never_doubles_in_a_url() {
        let flow = PairingFlow::new(
            "https://api.nomoreide.com/".to_string(),
            RemoteCredentials::new(std::env::temp_dir()),
        );

        assert_eq!(flow.base_url(), "https://api.nomoreide.com");
    }

    /// Two seconds is fast enough to feel immediate and slow enough that a
    /// ten-minute pairing is hundreds of requests, not thousands.
    #[test]
    fn polling_is_paced_for_a_ten_minute_pairing() {
        let polls = Duration::from_secs(600).as_secs() / POLL_INTERVAL.as_secs();

        assert!((100..=400).contains(&polls), "{polls}");
    }
}
