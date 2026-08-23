//! Which of a profile's values are secrets, and what they are called once they
//! are not in it any more.
//!
//! An exported profile carries no secret. Every env var and every header whose
//! *name* says it holds one is replaced by a `${credentials.<key>}` placeholder
//! and listed in the archive's manifest, so importing it asks for the secret
//! rather than shipping it.
//!
//! Only the name is looked at. A token pasted into `PLAIN_VALUE` is exported in
//! the clear, and no amount of shape-matching on the value changes that — the
//! reference does not inspect values at all, and this is the same tool.

use crate::agent_env::{Json, OrderedMap};

/// The words that make a name a secret, matched against the whole normalised
/// name or against its last `_`-separated run.
///
/// This is why `API_KEY` is redacted and `PRIVATE_KEY` is not: `key` is not one
/// of these, and `api_key` is matched whole. `TOKENS` and `TOKENIZER` are not
/// `token`, and `XTOKEN` has no boundary before it.
const SENSITIVE: [&str; 5] = ["token", "secret", "password", "api_key", "authorization"];

/// The name a secret is asked for by, which is also the placeholder's key.
///
/// `GITHUB_TOKEN`, `githubToken`, `github-token` and `GithubToken` are one
/// credential, `github_token`. Case is not simply folded away: the two
/// camel-case splits run first, so `tOkEn` becomes `t_ok_en` and is nobody's
/// token, while `Token` becomes `token` and is.
pub fn normalize(key: &str) -> String {
    let split_lower_upper = |text: &str| {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        for (index, character) in chars.iter().enumerate() {
            if index > 0
                && character.is_ascii_uppercase()
                && (chars[index - 1].is_ascii_lowercase() || chars[index - 1].is_ascii_digit())
            {
                out.push('_');
            }
            out.push(*character);
        }
        out
    };
    // `XMLSecret` is `xml_secret`, not `x_m_l_secret`: a run of capitals breaks
    // before the last one only when a lowercase letter follows it.
    let split_acronym = |text: &str| {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        for (index, character) in chars.iter().enumerate() {
            if index > 0
                && character.is_ascii_uppercase()
                && chars[index - 1].is_ascii_uppercase()
                && chars.get(index + 1).is_some_and(char::is_ascii_lowercase)
            {
                out.push('_');
            }
            out.push(*character);
        }
        out
    };
    // Every run of anything that is not a letter or a digit is one `_`, so
    // `A--TOKEN`, `B..TOKEN`, `C  TOKEN` and `F__TOKEN` are all one name.
    let split = split_acronym(&split_lower_upper(key));
    let mut out = String::with_capacity(split.len());
    let mut in_separator = false;
    for character in split.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character);
            in_separator = false;
        } else if !in_separator {
            out.push('_');
            in_separator = true;
        }
    }
    out.to_lowercase()
}

/// Whether a name says its value is a secret.
pub fn is_sensitive(key: &str) -> bool {
    let normalized = normalize(key);
    SENSITIVE
        .iter()
        .any(|word| normalized == *word || normalized.ends_with(&format!("_{word}")))
}

/// What the manifest says a credential is for.
///
/// It quotes the names the profile actually uses, not the normalised key — and
/// *every* one of them, because a server can reach the same secret twice:
/// `SHARED_TOKEN` in its environment and `Shared-Token` in its headers are one
/// credential with two names, and someone supplying it should see both.
pub fn description(mentions: &[Mention]) -> String {
    let names: Vec<String> = mentions
        .iter()
        .map(|mention| match mention.source {
            Source::Env => format!("Environment variable {}", mention.name),
            Source::Header => format!("Header {}", mention.name),
        })
        .collect();
    format!("{} required for MCP access", names.join("; "))
}

/// One place in a server where a secret is named.
#[derive(Debug, Clone, PartialEq)]
pub struct Mention {
    pub key: String,
    pub source: Source,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Env,
    Header,
}

/// One secret an archive needs filled in before its MCP servers will run.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Credential {
    pub key: String,
    pub required: bool,
    pub description: String,
}

/// The placeholder that stands in for a secret in an exported profile.
pub fn placeholder(key: &str) -> String {
    format!("${{credentials.{key}}}")
}

/// The credential key a placeholder asks for, if the value is one.
pub fn placeholder_key(value: &str) -> Option<&str> {
    value
        .strip_prefix("${credentials.")
        .and_then(|rest| rest.strip_suffix('}'))
}

/// Replace every secret in one `env`/`headers` map with its placeholder, and
/// report where each one was named.
///
/// Reported in the map's own order and not grouped: the caller collects these
/// across a server's env *and* headers before deciding either the order they
/// are listed in or how they are described.
pub fn redact(map: &mut OrderedMap<Json>, source: Source) -> Vec<Mention> {
    let mut taken = Vec::new();
    let names: Vec<String> = map.iter().map(|(name, _)| name.to_string()).collect();
    for name in names {
        if !is_sensitive(&name) {
            continue;
        }
        let key = normalize(&name);
        map.set(name.clone(), Json::String(placeholder(&key)));
        taken.push(Mention { key, source, name });
    }
    taken
}

/// Put a supplied secret back where its placeholder is, and report the keys
/// nothing was supplied for.
///
/// A key with nothing behind it keeps its placeholder rather than being blanked
/// — the profile is still readable, and re-importing with the secret in hand
/// fixes it.
pub fn resolve(
    map: &mut OrderedMap<Json>,
    supplied: &dyn Fn(&str) -> Option<String>,
    unresolved: &mut Vec<String>,
) {
    let entries: Vec<(String, Option<String>)> = map
        .iter()
        .map(|(name, value)| {
            let key = match value {
                Json::String(text) => placeholder_key(text).map(str::to_string),
                _ => None,
            };
            (name.to_string(), key)
        })
        .collect();
    for (name, key) in entries {
        let Some(key) = key else { continue };
        match supplied(&key) {
            Some(value) => map.set(name, Json::String(value)),
            None => {
                if !unresolved.contains(&key) {
                    unresolved.push(key);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_the_ways_a_name_can_be_spelled() {
        for (input, expected) in [
            ("GITHUB_TOKEN", "github_token"),
            ("githubToken", "github_token"),
            ("github-token", "github_token"),
            ("GithubToken", "github_token"),
            ("APIKey", "api_key"),
            ("HTTPToken", "http_token"),
            ("XMLSecret", "xml_secret"),
            ("X-Api-Key", "x_api_key"),
            ("Proxy-Authorization", "proxy_authorization"),
        ] {
            assert_eq!(normalize(input), expected, "{input}");
        }
    }

    /// The mixed-case spellings are the ones a careless fold would redact.
    #[test]
    fn a_name_is_not_a_secret_just_because_it_reads_like_one() {
        for redacted in [
            "token",
            "Token",
            "TOKEN",
            "API_KEY",
            "api_key",
            "apiKey",
            "X_Token",
            "PREFIX_TOKEN",
            "CLIENT_SECRET",
            "Authorization",
            "sessionToken",
        ] {
            assert!(is_sensitive(redacted), "{redacted} should be a secret");
        }
        for kept in [
            "tOkEn",
            "ToKeN",
            "toKEN",
            "TOken",
            "tokeN",
            "Token_X",
            "TOKEN_SUFFIX",
            "MY_TOKEN_HERE",
            "TOKENS",
            "TOKENIZER",
            "XTOKEN",
            "APIKEY",
            "KEY",
            "PRIVATE_KEY",
            "secret_key",
            "AUTH",
            "PASSWD",
            "MONKEY",
        ] {
            assert!(!is_sensitive(kept), "{kept} should not be a secret");
        }
    }

    #[test]
    fn every_run_of_punctuation_is_one_underscore() {
        for (input, expected) in [
            ("A--TOKEN", "a_token"),
            ("B..TOKEN", "b_token"),
            ("C  TOKEN", "c_token"),
            ("F__TOKEN", "f_token"),
            ("D/TOKEN", "d_token"),
        ] {
            assert_eq!(normalize(input), expected, "{input}");
        }
    }

    #[test]
    fn a_credential_named_twice_is_described_twice() {
        let mentions = [
            Mention {
                key: "shared_token".to_string(),
                source: Source::Env,
                name: "SHARED_TOKEN".to_string(),
            },
            Mention {
                key: "shared_token".to_string(),
                source: Source::Header,
                name: "Shared-Token".to_string(),
            },
        ];
        assert_eq!(
            description(&mentions),
            "Environment variable SHARED_TOKEN; Header Shared-Token required for MCP access"
        );
    }

    #[test]
    fn a_placeholder_round_trips() {
        assert_eq!(placeholder("github_token"), "${credentials.github_token}");
        assert_eq!(
            placeholder_key("${credentials.github_token}"),
            Some("github_token")
        );
        assert_eq!(placeholder_key("a real value"), None);
    }
}
