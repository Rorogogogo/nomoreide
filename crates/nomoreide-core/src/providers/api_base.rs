//! Where a provider's API calls go — the vendor, unless the environment names
//! a loopback stand-in.
//!
//! The Rust half of `src/core/providers/api-base.ts`, and it has to agree with
//! it exactly: the deploy parity gate points both runtimes at the same stub by
//! setting the same variable, so a rule that differed would show up as one
//! runtime talking to a vendor that is not there.
//!
//! **The override is loopback-only, and that is the whole safety argument.** A
//! value naming any other host is ignored rather than rejected, so a stray or
//! hostile variable in an inherited environment cannot redirect a
//! credential-bearing request off the machine. `http:` is accepted alongside
//! `https:` because a loopback stub has no certificate and needs none — the
//! request never leaves the loopback interface.

/// Hosts that cannot leave the machine, and so need no transport encryption.
pub(crate) const LOOPBACK: &[&str] = &["127.0.0.1", "localhost", "[::1]", "::1"];

/// # Arguments
/// * `variable` — environment variable naming the stand-in, e.g. `NOMOREIDE_VERCEL_API_BASE`.
/// * `fallback` — the vendor's real base URL, returned whenever the override is
///   absent, unparseable, or not loopback.
pub fn provider_api_base(variable: &str, fallback: &str) -> String {
    let Ok(raw) = std::env::var(variable) else {
        return fallback.to_string();
    };
    let candidate = raw.trim();
    if candidate.is_empty() {
        return fallback.to_string();
    }
    let Ok(parsed) = url::Url::parse(candidate) else {
        return fallback.to_string();
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return fallback.to_string();
    }
    if !is_loopback(parsed.host_str().unwrap_or_default()) {
        return fallback.to_string();
    }
    candidate.trim_end_matches('/').to_string()
}

/// The hostname a scoped client must admit for a base URL — the allowlist
/// follows the base, so the two cannot drift apart.
pub fn provider_api_host(base: &str) -> String {
    url::Url::parse(base)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_default()
}

pub fn is_loopback(host: &str) -> bool {
    LOOPBACK.contains(&host)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `std::env` is process-global, so these run under one lock rather than
    /// in parallel — a sibling test reading the same variable would otherwise
    /// see whichever value won the race.
    static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const VARIABLE: &str = "NOMOREIDE_TEST_API_BASE";
    const VENDOR: &str = "https://api.vendor.test/v1";

    fn with_override(value: Option<&str>, check: impl FnOnce()) {
        let _lock = GUARD.lock().unwrap_or_else(|error| error.into_inner());
        match value {
            Some(value) => std::env::set_var(VARIABLE, value),
            None => std::env::remove_var(VARIABLE),
        }
        check();
        std::env::remove_var(VARIABLE);
    }

    #[test]
    fn is_the_vendor_when_nothing_overrides_it() {
        with_override(None, || {
            assert_eq!(provider_api_base(VARIABLE, VENDOR), VENDOR);
        });
    }

    #[test]
    fn accepts_a_loopback_stand_in() {
        for (value, expected) in [
            ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
            ("http://localhost:1", "http://localhost:1"),
            ("https://127.0.0.1:8443", "https://127.0.0.1:8443"),
            ("http://127.0.0.1:8080/", "http://127.0.0.1:8080"),
            ("http://127.0.0.1:8080///", "http://127.0.0.1:8080"),
            ("  http://127.0.0.1:8080  ", "http://127.0.0.1:8080"),
        ] {
            with_override(Some(value), || {
                assert_eq!(provider_api_base(VARIABLE, VENDOR), expected, "{value}");
            });
        }
    }

    /// Every one of these is the case the loopback rule exists for: an override
    /// that would put a bearer token somewhere it does not belong.
    #[test]
    fn ignores_anything_that_is_not_loopback() {
        for value in [
            "https://api.evil.example",
            "http://169.254.169.254/latest/meta-data",
            "https://127.0.0.1.evil.example",
            "file:///etc/passwd",
            "ftp://127.0.0.1/x",
            "not a url",
            "",
            "   ",
        ] {
            with_override(Some(value), || {
                assert_eq!(provider_api_base(VARIABLE, VENDOR), VENDOR, "{value}");
            });
        }
    }

    #[test]
    fn a_host_is_the_part_a_scoped_client_admits() {
        assert_eq!(
            provider_api_host("https://api.vercel.com"),
            "api.vercel.com"
        );
        assert_eq!(
            provider_api_host("https://api.cloudflare.com/client/v4"),
            "api.cloudflare.com"
        );
        assert_eq!(provider_api_host("http://127.0.0.1:8080"), "127.0.0.1");
    }
}
