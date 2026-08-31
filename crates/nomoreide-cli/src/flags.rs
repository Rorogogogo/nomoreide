//! The reference CLI's argument parsing, quirks included.
//!
//! The Rust half of `src/cli/flags.ts` plus the two different positional-
//! argument readers that grew up beside it. None of this is how one would
//! design a parser today — it is what `nomoreide` has shipped, and a flag that
//! parses differently under the native binary is a script that breaks on
//! upgrade. So the quirks below are reproduced deliberately, each one noted at
//! the line that reproduces it.

use std::collections::HashMap;

/// A parsed flag table.
///
/// The value is `Option<String>` rather than `String` because the reference
/// stores `undefined` for a trailing `--flag` with nothing after it, and that
/// is observably different from `--flag=`: the first is nullish and loses to
/// `??`, the second is an empty string and wins.
#[derive(Debug, Default, Clone)]
pub struct Flags {
    inner: HashMap<String, Option<String>>,
}

impl Flags {
    /// The `flags.x ?? fallback` reading: a key that is present with a defined
    /// value, even an empty one.
    pub fn nullish(&self, name: &str) -> Option<&str> {
        self.inner.get(name).and_then(|value| value.as_deref())
    }

    /// The `if (!flags.x)` reading: JS falsiness, so an empty string counts as
    /// absent. `--command=` is "no command was given", not "the empty command".
    pub fn truthy(&self, name: &str) -> Option<&str> {
        self.nullish(name).filter(|value| !value.is_empty())
    }
}

/// Mirror of `parseFlags`.
///
/// Two quirks that scripts in the wild depend on, both from the reference's
/// `split("=", 2)`:
///
/// * `--foo=bar=baz` yields `bar`, not `bar=baz` — JS's two-argument `split`
///   discards the remainder rather than keeping it as the last field.
/// * `--foo= next` yields an empty `foo` *and* swallows `next`, because the
///   reference tests the inline value for truthiness rather than presence.
pub fn parse_flags(args: &[String]) -> Flags {
    let mut flags: HashMap<String, Option<String>> = HashMap::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if !arg.starts_with("--") {
            index += 1;
            continue;
        }
        let body = &arg[2..];
        let (key, inline) = match body.split_once('=') {
            // `split("=", 2)` keeps only the first field after the split, so a
            // second `=` and everything after it is dropped.
            Some((key, rest)) => (key, Some(rest.split('=').next().unwrap_or("").to_string())),
            None => (body, None),
        };
        let value = match &inline {
            Some(value) => Some(value.clone()),
            None => args.get(index + 1).cloned(),
        };
        flags.insert(to_camel_case(key), value);
        // Advance past the consumed value only when there was no inline one —
        // and note the reference tests `!inlineValue`, so an *empty* inline
        // value advances too, eating the following argument.
        // `map_or` rather than `is_none_or`: the workspace MSRV predates it.
        if inline.as_deref().map_or(true, str::is_empty) {
            index += 1;
        }
        index += 1;
    }
    Flags { inner: flags }
}

/// `--compose-service` becomes `composeService`. Only a lowercase letter is
/// lifted, matching the reference's `/-([a-z])/g`, so `--compose-Service` stays
/// as it is written.
fn to_camel_case(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '-' {
            if let Some(next) = chars.peek().copied().filter(char::is_ascii_lowercase) {
                chars.next();
                out.extend(next.to_uppercase());
                continue;
            }
        }
        out.push(character);
    }
    out
}

/// The positional reader used by `git` and `profile`.
///
/// A bare argument counts unless the argument before it was a flag without an
/// `=`, on the assumption that it is that flag's value. It is a heuristic and
/// it is wrong for a boolean flag followed by a positional — `--force name`
/// loses `name` — but that is the shipped behaviour, and the callers work
/// around it by putting positionals first.
pub fn positional_args(args: &[String]) -> Vec<String> {
    args.iter()
        .enumerate()
        .filter(|(index, arg)| {
            if arg.starts_with("--") {
                return false;
            }
            match index.checked_sub(1).and_then(|previous| args.get(previous)) {
                // De Morgan'd from the reference's `!(flag && !inline)`: an
                // argument counts unless the one before it was a flag with no
                // `=`, on the assumption it is that flag's value.
                Some(previous) => !previous.starts_with("--") || previous.contains('='),
                None => true,
            }
        })
        .map(|(_, arg)| arg.clone())
        .collect()
}

/// The positional reader used by `db`, which knows which flags take a value
/// instead of guessing. `--replace` and `--no-check` are booleans, so a
/// positional after either is kept — the `git` reader above would drop it.
pub fn positional_args_with_value_flags(args: &[String], value_flags: &[&str]) -> Vec<String> {
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if !argument.starts_with("--") {
            positional.push(argument.clone());
            index += 1;
            continue;
        }
        let flag = argument.split('=').next().unwrap_or("");
        if !argument.contains('=') && value_flags.contains(&flag) {
            index += 1;
        }
        index += 1;
    }
    positional
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn a_second_equals_sign_is_dropped_the_way_js_split_drops_it() {
        let flags = parse_flags(&args(&["--url=postgres://h/db?a=b"]));
        assert_eq!(flags.nullish("url"), Some("postgres://h/db?a"));
    }

    /// The nastiest of the quirks: an empty inline value is falsy, so the
    /// reference advances past the *next* argument as though it were the
    /// value it already has.
    #[test]
    fn an_empty_inline_value_still_swallows_the_next_argument() {
        let flags = parse_flags(&args(&["--command=", "--port", "3000"]));
        assert_eq!(flags.nullish("command"), Some(""));
        assert_eq!(flags.truthy("command"), None);
        // `--port` was eaten as the empty flag's phantom value.
        assert_eq!(flags.nullish("port"), None);
    }

    #[test]
    fn a_trailing_flag_has_no_value_at_all() {
        let flags = parse_flags(&args(&["--command"]));
        assert_eq!(flags.nullish("command"), None);
    }

    #[test]
    fn only_a_lowercase_letter_is_lifted_over_a_dash() {
        assert_eq!(to_camel_case("compose-service"), "composeService");
        assert_eq!(to_camel_case("a-b-c"), "aBC");
        assert_eq!(to_camel_case("a--b"), "a-B");
        assert_eq!(to_camel_case("no-Check"), "no-Check");
    }

    #[test]
    fn the_git_reader_drops_a_positional_after_a_valueless_flag() {
        assert_eq!(
            positional_args(&args(&["--force", "name"])),
            Vec::<String>::new()
        );
        assert_eq!(positional_args(&args(&["name", "--force"])), vec!["name"]);
        assert_eq!(positional_args(&args(&["--as=x", "name"])), vec!["name"]);
    }

    #[test]
    fn the_db_reader_keeps_a_positional_after_a_boolean_flag() {
        let value_flags = ["--engine", "--url"];
        assert_eq!(
            positional_args_with_value_flags(&args(&["--replace", "name"]), &value_flags),
            vec!["name"]
        );
        assert_eq!(
            positional_args_with_value_flags(
                &args(&["--engine", "postgres", "name"]),
                &value_flags
            ),
            vec!["name"]
        );
    }
}
