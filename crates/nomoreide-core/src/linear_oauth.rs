//! Browser sign-in for Linear: OAuth 2.0 authorization code + PKCE against the
//! daemon's own callback route.
//!
//! Linear's authorization server does less than Vercel's, in the two ways that
//! decide the shape of everything here:
//!
//! 1. **No discovery document.** There is no
//!    `/.well-known/openid-configuration` to read, so the two endpoints are
//!    constants and travel in the spec's [`endpoints`](ProviderOAuthSpec::endpoints).
//! 2. **No dynamic client registration.** A client id is minted by a person in
//!    Linear's settings and cannot be asked for, so it travels in the spec's
//!    [`client_id`](ProviderOAuthSpec::client_id) instead of being registered
//!    per sign-in.
//!
//! Neither is a reason for a second PKCE implementation, which is why
//! [`crate::providers::oauth`] grew those two fields rather than this file
//! growing a copy of the flow.
//!
//! **This is a public client, and that is not a compromise.** Linear makes
//! `client_secret` optional when a request carries a PKCE `code_verifier`, so
//! the exchange proves possession of the verifier rather than of a secret. That
//! matters here specifically: a locally installed binary cannot keep a secret
//! from the person running it, so a flow that needed one would be shipping a
//! secret that is not secret. The client id it does ship identifies the app and
//! authorizes nothing on its own, exactly as [`crate::github_oauth`]'s does.
//!
//! **The redirect URI is fixed, unlike Vercel's.** Vercel registers a client
//! per sign-in and can therefore name an ephemeral loopback port; Linear checks
//! the redirect against a list a person typed into a form, and no such list can
//! anticipate a random port. So the callback is a route on the daemon's own
//! server at its fixed port, and [`REDIRECT_URI`] is the one string that must
//! also appear in the Linear app's settings.

use crate::providers::oauth::{OAuthMetadata, ProviderOAuthSpec};

/// Where Linear's authorization server lives. Two constants because there is no
/// document to read them from.
const AUTHORIZE_ENDPOINT: &str = "https://linear.app/oauth/authorize";
const TOKEN_ENDPOINT: &str = "https://api.linear.app/oauth/token";

/// What the daemon asks Linear for.
///
/// `read` and `write` are what the task panel does — list, create, update,
/// comment. `issues:create` and `comments:create` are *not* added on top: they
/// are narrower grants for apps that only do those things, and asking for a
/// subset beside the superset only lengthens the consent screen.
const SCOPES: &str = "read write";

/// The app the sign-in authorizes.
///
/// Public by design, exactly as [`crate::github_oauth`]'s device-flow id is: it
/// identifies the app to Linear and authorizes nothing on its own. The client
/// *secret* Linear issues alongside it is deliberately unused and must not be
/// compiled in or read from the environment — see the module docs.
///
/// A blank id is not an error, and the gate stays: an install that clears this
/// (or overrides it with nothing) gets the API-key form and no "Connect with
/// Linear" button, the same way GitHub's `deviceFlowAvailable` works.
const DEFAULT_CLIENT_ID: &str = "fce253c6be9f2deea1fea6fbd493d5af";

/// Where Linear sends the browser back to.
///
/// **This exact string must be registered as a redirect URI on the Linear OAuth
/// app**, or every sign-in is refused before the user sees a consent screen.
/// It names the daemon's fixed port because Linear matches redirects literally;
/// see the module docs for why an ephemeral port is not an option here.
pub const REDIRECT_URI: &str = "http://127.0.0.1:4317/api/linear/oauth/callback";

/// Which app to authorize as. An override that trims away to nothing is not an
/// override, so a variable set to blank behaves as if it were unset.
pub fn client_id() -> String {
    std::env::var("NOMOREIDE_LINEAR_CLIENT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

/// Whether this install can offer a browser sign-in at all.
pub fn available() -> bool {
    !client_id().is_empty()
}

/// Linear's half of the shared browser sign-in.
pub fn linear_oauth() -> ProviderOAuthSpec {
    ProviderOAuthSpec {
        name: "Linear".into(),
        // Not read, because `endpoints` is set — but it is the key the shared
        // discovery cache is written under, so it stays a real, distinct host.
        issuer: "https://linear.app".into(),
        scope: SCOPES.into(),
        callback_path: "/api/linear/oauth/callback".into(),
        client_name: Some("NoMoreIDE".into()),
        endpoints: Some(OAuthMetadata {
            authorization_endpoint: AUTHORIZE_ENDPOINT.into(),
            token_endpoint: TOKEN_ENDPOINT.into(),
            // Linear has neither.
            registration_endpoint: None,
            userinfo_endpoint: None,
        }),
        client_id: Some(client_id()),
    }
}

/// How Linear wants a credential presented.
///
/// The two kinds go in differently and Linear refuses the wrong one: a personal
/// API key is sent raw, an OAuth access token is sent as a bearer. Getting this
/// backwards is a 401 that reads exactly like an expired token, so it is
/// decided once, here, from how the connection was made.
pub fn authorization_header(source: &str, token: &str) -> String {
    if source == "oauth" {
        format!("Bearer {token}")
    } else {
        token.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stated_client_id_and_endpoints_travel_in_the_spec() {
        let spec = linear_oauth();
        let endpoints = spec.endpoints.expect("Linear states its endpoints");
        assert_eq!(endpoints.authorization_endpoint, AUTHORIZE_ENDPOINT);
        assert_eq!(endpoints.token_endpoint, TOKEN_ENDPOINT);
        // No registration endpoint is the whole reason `client_id` is stated.
        assert!(endpoints.registration_endpoint.is_none());
        assert!(spec.client_id.is_some());
    }

    /// An OAuth token sent raw, or an API key sent as a bearer, is a 401 that
    /// looks like a revoked credential. Worth a test precisely because the
    /// failure blames the wrong thing.
    #[test]
    fn only_an_oauth_token_is_sent_as_a_bearer() {
        assert_eq!(authorization_header("oauth", "tok"), "Bearer tok");
        assert_eq!(authorization_header("stored", "lin_api_x"), "lin_api_x");
        assert_eq!(authorization_header("cli", "lin_api_x"), "lin_api_x");
    }
}
