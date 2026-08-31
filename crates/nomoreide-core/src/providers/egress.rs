//! The provider egress boundary — a request path scoped to one provider's
//! declared hosts.
//!
//! The Rust half of `src/core/providers/egress.ts`, and it exists for the same
//! reason: a provider necessarily receives credentials and runs inside the
//! daemon, beside GitHub tokens, write-capable database access, and the ability
//! to spawn processes. In-tree that buys documentation rather than protection —
//! but a boundary the TypeScript daemon enforces and the native one does not is
//! a security control this migration would have quietly deleted.
//!
//! Two rules, both checked against the **final** URL rather than the path a
//! caller passed:
//!
//! 1. The host must be one the provider declares. Matched exactly, no
//!    wildcards: every vendor here has a customer-controlled subdomain space
//!    (`*.vercel.app`, `*.pages.dev`), so a pattern reads as a convenience
//!    while admitting hosts the vendor does not control.
//! 2. The scheme must be `https`, or `http` to a loopback host — which is
//!    reachable only because `provider_api_base()` accepted an override naming
//!    one, and has no wire for a token to be read off.
//!
//! Redirects are followed by hand so that every hop goes back through both
//! rules. `reqwest`'s own following would let an allowlisted host bounce a
//! credential-bearing request to an unlisted one, and open redirects on vendor
//! APIs are common enough that this is not theoretical.

use super::api_base::is_loopback;

/// A redirect chain long enough to be a loop rather than a vendor moving a
/// resource. Mirrors the reference's cap.
const MAX_REDIRECTS: usize = 5;

/// A refused request. Distinct from any vendor API error because nothing was
/// sent — there is no status and no vendor to blame, only a provider asking for
/// something its manifest does not declare.
#[derive(Debug, Clone)]
pub struct EgressError {
    pub message: String,
}

impl std::fmt::Display for EgressError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

/// One provider's allowlist, minted from its manifest.
#[derive(Debug, Clone)]
pub struct ProviderEgress {
    id: &'static str,
    hosts: Vec<String>,
}

impl ProviderEgress {
    pub fn new(id: &'static str, hosts: Vec<String>) -> Self {
        Self {
            id,
            hosts: hosts.into_iter().map(|host| host.to_lowercase()).collect(),
        }
    }

    /// The check itself. Fails before anything is sent, so a refused call leaks
    /// nothing.
    pub fn allow(&self, url: &str) -> Result<url::Url, EgressError> {
        let parsed = url::Url::parse(url).map_err(|_| EgressError {
            message: format!(
                "Provider \"{}\" asked for a URL that is not absolute: {url}",
                self.id
            ),
        })?;
        let host = parsed.host_str().unwrap_or_default().to_lowercase();

        // Scheme is checked first: `file:` and `data:` have no host to compare.
        if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_loopback(&host)) {
            return Err(EgressError {
                message: format!(
                    "Provider \"{}\" may only use https, not {}: {parsed}",
                    self.id,
                    parsed.scheme()
                ),
            });
        }

        if !self.hosts.iter().any(|allowed| allowed == &host) {
            return Err(EgressError {
                message: format!(
                    "Provider \"{}\" is not allowed to reach {host}. Its manifest declares: {}.",
                    self.id,
                    if self.hosts.is_empty() {
                        "no hosts".to_string()
                    } else {
                        self.hosts.join(", ")
                    }
                ),
            });
        }

        Ok(parsed)
    }

    /// Sends one request, checking every hop of a redirect chain.
    ///
    /// `build` is called per hop rather than once, because a `RequestBuilder`
    /// is consumed by sending it — and because a redirect that downgrades the
    /// method has to rebuild the request anyway.
    pub async fn send(
        &self,
        client: &reqwest::Client,
        url: &str,
        build: impl Fn(&reqwest::Client, reqwest::Method, url::Url) -> reqwest::RequestBuilder,
        method: reqwest::Method,
    ) -> Result<reqwest::Response, EgressError> {
        let mut target = self.allow(url)?;
        let mut method = method;
        for hop in 0..=MAX_REDIRECTS {
            let response = build(client, method.clone(), target.clone())
                .send()
                .await
                .map_err(|error| EgressError {
                    message: error.to_string(),
                })?;
            let Some(location) = redirect_target(&response) else {
                return Ok(response);
            };
            if hop == MAX_REDIRECTS {
                return Err(EgressError {
                    message: format!(
                        "Provider \"{}\" was redirected more than {MAX_REDIRECTS} times from {target}.",
                        self.id
                    ),
                });
            }
            let next = target.join(&location).map_err(|_| EgressError {
                message: format!(
                    "Provider \"{}\" asked for a URL that is not absolute: {location}",
                    self.id
                ),
            })?;
            method = after_redirect(method, response.status().as_u16());
            target = self.allow(next.as_str())?;
        }
        unreachable!("the loop returns on its last iteration")
    }
}

/// The URL a response redirects to, or none when it is not a redirect.
fn redirect_target(response: &reqwest::Response) -> Option<String> {
    let status = response.status().as_u16();
    if !(300..=399).contains(&status) {
        return None;
    }
    response
        .headers()
        .get(reqwest::header::LOCATION)?
        .to_str()
        .ok()
        .map(str::to_string)
}

/// How a request changes across a redirect, per the Fetch standard: 303 always
/// becomes a GET, and 301/302 turn a POST into one.
fn after_redirect(method: reqwest::Method, status: u16) -> reqwest::Method {
    let downgrades =
        status == 303 || ((status == 301 || status == 302) && method == reqwest::Method::POST);
    if downgrades {
        reqwest::Method::GET
    } else {
        method
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acme() -> ProviderEgress {
        ProviderEgress::new("acme", vec!["api.acme.test".into()])
    }

    #[test]
    fn passes_a_declared_host_through() {
        assert!(acme().allow("https://api.acme.test/v1/projects").is_ok());
    }

    #[test]
    fn refuses_an_undeclared_host_and_says_what_is_declared() {
        let error = acme()
            .allow("https://evil.example.com/collect")
            .unwrap_err();
        assert_eq!(
            error.message,
            "Provider \"acme\" is not allowed to reach evil.example.com. Its manifest declares: api.acme.test."
        );
    }

    /// No wildcards: a customer-controlled subdomain is not the vendor.
    #[test]
    fn refuses_a_subdomain_of_a_declared_host() {
        assert!(acme().allow("https://evil.api.acme.test/x").is_err());
        assert!(acme()
            .allow("https://api.acme.test.evil.example/x")
            .is_err());
    }

    #[test]
    fn matches_a_host_case_insensitively() {
        assert!(acme().allow("https://API.ACME.TEST/v1").is_ok());
    }

    /// The schemes ruled out are the interesting ones: `file:` reads the disk
    /// and `data:` smuggles a payload past a host check entirely.
    #[test]
    fn refuses_every_scheme_but_https() {
        for url in [
            "http://api.acme.test/v1",
            "file:///etc/passwd",
            "data:text/plain,hello",
        ] {
            assert!(acme().allow(url).is_err(), "{url}");
        }
    }

    #[test]
    fn refuses_a_relative_url_rather_than_resolving_it_somewhere() {
        let error = acme().allow("/v1/projects").unwrap_err();
        assert!(error.message.contains("is not absolute"), "{error}");
    }

    /// The one `http:` opening, and it is still gated on the manifest.
    #[test]
    fn a_loopback_stand_in_is_reachable_only_when_declared() {
        let loopback = ProviderEgress::new("acme", vec!["127.0.0.1".into()]);
        assert!(loopback.allow("http://127.0.0.1:8080/v1").is_ok());
        assert!(loopback.allow("https://127.0.0.1:8443/v1").is_ok());
        assert!(acme().allow("http://127.0.0.1:8080/v1").is_err());
        assert!(loopback.allow("http://127.0.0.1.evil.example/v1").is_err());
    }

    #[test]
    fn a_redirect_downgrades_the_method_the_way_fetch_does() {
        assert_eq!(
            after_redirect(reqwest::Method::POST, 303),
            reqwest::Method::GET
        );
        assert_eq!(
            after_redirect(reqwest::Method::POST, 302),
            reqwest::Method::GET
        );
        assert_eq!(
            after_redirect(reqwest::Method::POST, 307),
            reqwest::Method::POST
        );
        assert_eq!(
            after_redirect(reqwest::Method::GET, 301),
            reqwest::Method::GET
        );
    }
}
