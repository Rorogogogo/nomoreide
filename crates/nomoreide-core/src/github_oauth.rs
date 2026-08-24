//! GitHub's OAuth device flow: the two calls that turn a code the user types
//! into a token this machine can store.
//!
//! Only the transport lives here. What each answer *means* — which shape is a
//! success, which is "still waiting", which is a refusal — is decided by the
//! caller, because that decision is the same one the reference makes in its
//! route rather than in a client.

use serde_json::{json, Value};

const GITHUB_WEB: &str = "https://github.com";
const DEVICE_CODE_PATH: &str = "/login/device/code";
const ACCESS_TOKEN_PATH: &str = "/login/oauth/access_token";
const SCOPES: &str = "repo workflow read:org";

/// The app the device flow authorizes.
///
/// Shipped with a default rather than demanded from the environment: the
/// client id of a device-flow app is public by design — it identifies the app
/// to GitHub and authorizes nothing on its own — so an install that sets
/// nothing still gets a working "Connect GitHub" button.
const DEFAULT_CLIENT_ID: &str = "Ov23litfv3LE0LevxlT2";

/// Which app to authorize as. An override that trims away to nothing is not an
/// override, so a variable set to blank behaves as if it were unset.
pub fn client_id() -> String {
    std::env::var("NOMOREIDE_GITHUB_CLIENT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

/// Where the device flow's endpoints live: `github.com`, unless
/// `NOMOREIDE_GITHUB_OAUTH_BASE` names a loopback address.
///
/// The same rule [`crate::github_manager::api_base`] follows, and for the same
/// reason: the second of these two calls *returns a token*, so an override
/// free to name any host would be a way to feed this machine someone else's
/// credential — or to collect the one it asked for.
pub fn oauth_base() -> String {
    crate::github_manager::loopback_override("NOMOREIDE_GITHUB_OAUTH_BASE", GITHUB_WEB)
}

/// Ask GitHub for a device code and the URL to type it into.
pub async fn request_device_code(client_id: &str) -> Result<Value, String> {
    post(
        DEVICE_CODE_PATH,
        json!({ "client_id": client_id, "scope": SCOPES }),
    )
    .await
}

/// Ask whether the user has finished authorizing yet.
pub async fn request_access_token(client_id: &str, device_code: &str) -> Result<Value, String> {
    post(
        ACCESS_TOKEN_PATH,
        json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }),
    )
    .await
}

/// One device-flow call.
///
/// The status is deliberately not checked. GitHub answers `authorization_
/// pending` with a 200 and some of its refusals with a 4xx, and the caller
/// tells those apart by the `error` field either way — so a body that parses
/// is handed over whatever the status line said, exactly as the reference's
/// unconditional `res.json()` does.
async fn post(path: &str, body: Value) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(format!("{}{path}", oauth_base()))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let text = response.text().await.map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}
