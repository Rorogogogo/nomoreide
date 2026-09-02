//! Cleaning a log line before it leaves the machine.
//!
//! Service logs are the one place raw local output crosses the remote boundary,
//! and what a service prints is not under anyone's control. A dev server prints
//! its database URL on startup. A test harness echoes the environment. A crash
//! dumps a request with its `Authorization` header still on it. None of that is
//! written to be read by a phone over someone else's network.
//!
//! Three passes, in this order:
//!
//! 1. **ANSI escapes** go, because a log line is data here, not a terminal
//!    instruction — and a control sequence rendered by a browser is at best
//!    noise and at worst a cursor-manipulation trick that makes one line look
//!    like another.
//! 2. **Secrets** are masked. Deliberately conservative patterns: the cost of a
//!    missed secret is a credential in a phone's scrollback, and the cost of a
//!    false positive is one unreadable line.
//! 3. **Length** is capped, and the caller is told, so a phone can say "cut"
//!    rather than showing a sentence that simply stops.
//!
//! This is not a guarantee that no secret ever escapes — nothing that reads
//! arbitrary output can promise that. It is the difference between a log stream
//! that leaks routinely and one that leaks rarely, and the bounded, opt-in,
//! per-service surface around it is what makes that trade acceptable.

use regex::Regex;
use std::sync::OnceLock;

/// What a masked value is replaced with. Fixed-width and obvious, so a reader
/// can tell redaction from a service that printed asterisks itself.
pub const MASK: &str = "[redacted]";

/// A line, cleaned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    pub text: String,
    /// Whether the line was cut to fit.
    pub truncated: bool,
}

/// Strip ANSI, mask secrets, and cap the length.
///
/// `known_secrets` are values this process already knows are secret — the
/// daemon's own credential, the device credential — masked by exact match. That
/// is the only precise part of this; everything else is a pattern, and patterns
/// are guesses.
pub fn redact_line(raw: &str, known_secrets: &[&str], max_bytes: usize) -> Redacted {
    let mut text = strip_ansi(raw);
    text = strip_control(&text);
    for secret in known_secrets {
        if secret.len() >= 8 && text.contains(secret) {
            text = text.replace(secret, MASK);
        }
    }
    text = mask_patterns(&text);
    truncate(text, max_bytes)
}

/// Remove CSI and OSC sequences.
fn strip_ansi(raw: &str) -> String {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    let pattern = ANSI.get_or_init(|| {
        // CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and the short two-byte
        // escapes. Written out rather than pulled from a crate because it is
        // twelve characters of regex and one fewer dependency in a published
        // crate.
        Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
            .expect("ANSI pattern")
    });
    pattern.replace_all(raw, "").into_owned()
}

/// Replace the control characters a terminal would act on.
///
/// Tabs survive — they are layout, and a log line full of them reads fine.
/// Everything else in the C0 range becomes a space, so a line cannot carry a
/// carriage return that overwrites what a phone already drew.
fn strip_control(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character == '\t' {
                character
            } else if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect()
}

/// Mask the shapes that are almost always credentials.
fn mask_patterns(text: &str) -> String {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            // `Authorization: Bearer …`, and bare `Bearer …`.
            Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._\-+/=]{8,}").expect("bearer"),
            // `password=…`, `token=…`, `secret=…`, `api_key=…`, and the `":"`
            // form a JSON log line uses.
            //
            // The name is matched as a *substring* of an identifier, not as a
            // whole word: the commonest shape in a real log is
            // `DATABASE_PASSWORD=…`, where a word boundary before `password`
            // never matches because `E` and `P` are both word characters. That
            // over-matches things like `token_expiry=30`, which costs one
            // unreadable line and is the right side to err on. The optional
            // quote before the separator is the JSON form, `"api_key": "…"`.
            Regex::new(
                r#"(?i)[A-Za-z0-9_.-]*(pass(?:word)?|passwd|token|secret|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*"?\s*[:=]\s*"?[^\s",;}]{4,}"#,
            )
            .expect("assignment"),
            // A URL with credentials in it — `postgres://user:pw@host`.
            Regex::new(r"(?i)\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:[^\s/@]+@").expect("url userinfo"),
            // Vendor-shaped tokens, which are unambiguous enough to match on
            // sight.
            Regex::new(r"\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b")
                .expect("vendor tokens"),
            // A long unbroken hex run: the shape of this project's own
            // credentials. The floor is 48 rather than 40 so a git SHA — which
            // appears in logs constantly and is not a secret — survives.
            Regex::new(r"\b[0-9a-fA-F]{48,}\b").expect("hex"),
        ]
    });

    let mut text = text.to_string();
    for pattern in patterns {
        text = pattern.replace_all(&text, MASK).into_owned();
    }
    text
}

/// Cut to `max_bytes` without splitting a character.
fn truncate(text: String, max_bytes: usize) -> Redacted {
    if text.len() <= max_bytes {
        return Redacted {
            text,
            truncated: false,
        };
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    Redacted {
        text: text[..end].to_string(),
        truncated: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(raw: &str) -> String {
        redact_line(raw, &[], 8192).text
    }

    #[test]
    fn colour_codes_are_removed_but_the_words_survive() {
        assert_eq!(
            clean("\x1b[32mlistening on 3000\x1b[0m"),
            "listening on 3000"
        );
        assert_eq!(clean("\x1b[1;31mERROR\x1b[m boom"), "ERROR boom");
    }

    /// A window-title escape is not something a browser should be handed.
    #[test]
    fn operating_system_commands_are_removed() {
        assert_eq!(clean("\x1b]0;a title\x07ready"), "ready");
    }

    /// A carriage return can redraw over a line a phone has already rendered,
    /// which is how one message is made to look like another.
    #[test]
    fn control_characters_become_spaces_but_tabs_stay() {
        assert_eq!(clean("a\rb\x08c"), "a b c");
        assert_eq!(clean("name\tvalue"), "name\tvalue");
    }

    /// The precise case: values this process knows are secret.
    #[test]
    fn a_known_secret_is_masked_exactly() {
        let credential = "c".repeat(64);
        let line = format!("GET /api/status auth={credential} ok");

        let cleaned = redact_line(&line, &[&credential], 8192).text;

        assert!(!cleaned.contains(&credential), "{cleaned}");
        assert!(cleaned.contains(MASK));
        assert!(cleaned.contains("GET /api/status"));
    }

    /// A short "secret" is not masked by exact match — it would turn every
    /// occurrence of a common word into `[redacted]`.
    #[test]
    fn a_short_known_value_is_not_treated_as_a_secret() {
        assert_eq!(redact_line("abc def", &["abc"], 8192).text, "abc def");
    }

    #[test]
    fn authorization_headers_are_masked() {
        for line in [
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
            "sending bearer sk_live_abcdefghijklmnop",
        ] {
            let cleaned = clean(line);
            assert!(cleaned.contains(MASK), "{line} -> {cleaned}");
            assert!(!cleaned.contains("eyJhbGciOiJIUzI1NiJ9"), "{cleaned}");
        }
    }

    #[test]
    fn assignments_that_name_a_secret_are_masked() {
        for line in [
            // The commonest shape of all, and the one a word boundary misses.
            "DATABASE_PASSWORD=hunter2000",
            "MY_APP_TOKEN=abcd1234",
            "token: abcd1234efgh",
            r#"{"api_key":"live_9f8e7d6c5b4a"}"#,
            "SECRET = s3cr3t-value",
        ] {
            let cleaned = clean(line);
            assert!(cleaned.contains(MASK), "{line} -> {cleaned}");
        }
    }

    /// The classic: a dev server printing its connection string.
    #[test]
    fn credentials_inside_a_url_are_masked() {
        let cleaned = clean("connecting to postgres://app:hunter2@db.internal:5432/prod");

        assert!(!cleaned.contains("hunter2"), "{cleaned}");
        // The host survives, because knowing *which* database is not the leak.
        assert!(cleaned.contains("db.internal"), "{cleaned}");
    }

    #[test]
    fn vendor_shaped_tokens_are_masked() {
        for token in [
            "sk-abcdefghijklmnopqrstuvwx",
            "ghp_abcdefghijklmnopqrstuvwxyz0123",
            "github_pat_11ABCDEFG0abcdefghij_klmnop",
            "xoxb-1234567890-abcdefghij",
            "AKIAIOSFODNN7EXAMPLE",
        ] {
            let cleaned = clean(&format!("using {token} now"));
            assert!(!cleaned.contains(token), "{token} survived as {cleaned}");
        }
    }

    /// This project's own credentials are 64 hex characters.
    #[test]
    fn a_long_hex_run_is_masked() {
        let cleaned = clean(&format!("credential {} ok", "a1b2c3d4".repeat(8)));

        assert!(cleaned.contains(MASK), "{cleaned}");
    }

    /// A git SHA is in half the log lines ever written and is not a secret.
    /// Masking it would make redaction something people turn off.
    #[test]
    fn a_git_sha_survives() {
        let sha = "e745c835a1b2c3d4e5f60718293a4b5c6d7e8f90";
        let cleaned = clean(&format!("HEAD is now at {sha}"));

        assert!(cleaned.contains(sha), "{cleaned}");
    }

    #[test]
    fn an_ordinary_line_is_left_alone() {
        for line in [
            "listening on http://localhost:3000",
            "compiled 42 modules in 1.2s",
            "GET /api/status 200 4ms",
        ] {
            assert_eq!(clean(line), line);
        }
    }

    #[test]
    fn a_long_line_is_cut_and_says_so() {
        let redacted = redact_line(&"x".repeat(100), &[], 20);

        assert_eq!(redacted.text.len(), 20);
        assert!(redacted.truncated);
    }

    /// Cutting must not split a character in half and produce invalid UTF-8.
    #[test]
    fn truncation_respects_character_boundaries() {
        let redacted = redact_line(&"é".repeat(50), &[], 21);

        assert!(redacted.truncated);
        assert!(redacted.text.len() <= 21);
        assert!(redacted.text.chars().all(|character| character == 'é'));
    }

    #[test]
    fn a_short_line_is_not_marked_truncated() {
        let redacted = redact_line("ready", &[], 20);

        assert_eq!(redacted.text, "ready");
        assert!(!redacted.truncated);
    }

    /// Escapes must not survive by hiding inside something that gets masked, or
    /// by being reassembled after a mask.
    #[test]
    fn nothing_escapes_by_combining_the_passes() {
        let cleaned = clean("\x1b[31mtoken=\x1b[0mabcdef123456\x1b[0m");

        assert!(!cleaned.contains('\x1b'), "{cleaned:?}");
        assert!(cleaned.contains(MASK), "{cleaned}");
    }
}
