//! Reading `.env` files the way the reference does.
//!
//! This is deliberately not a general dotenv implementation. It mirrors one
//! specific parser, including the parts a stricter reader would reject: a line
//! that does not look like an assignment is kept as-is rather than raising, so
//! a hand-edited file with a stray note in it still yields its other values.
//!
//! The line kinds are preserved rather than flattened straight to pairs because
//! a writer has to put the comments and blank lines back where it found them.
//! Only the reading half is used today.

use std::path::Path;

/// One parsed line: either an assignment or anything else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvLine {
    Pair {
        key: String,
        value: String,
        /// The quote the value arrived in, so a writer can restore it.
        quote: Quote,
    },
    Raw(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quote {
    None,
    Single,
    Double,
}

/// A key and its unquoted value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvEntry {
    pub key: String,
    pub value: String,
}

/// Split a file into lines.
///
/// The trailing element after a final newline is dropped -- a file ending in
/// `\n` describes the same assignments as one that does not, and keeping the
/// empty string would add a blank line every time such a file is rewritten.
pub fn parse(content: &str) -> Vec<EnvLine> {
    let mut lines: Vec<&str> = split_lines(content);
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines.iter().map(|line| parse_line(line)).collect()
}

/// The assignments, in the order they appeared.
pub fn entries(lines: &[EnvLine]) -> Vec<EnvEntry> {
    lines
        .iter()
        .filter_map(|line| match line {
            EnvLine::Pair { key, value, .. } => Some(EnvEntry {
                key: key.clone(),
                value: value.clone(),
            }),
            EnvLine::Raw(_) => None,
        })
        .collect()
}

/// Read and parse a file. A file that is not there is not an error -- most
/// services have no `.env`, and that is the ordinary case, not a failure.
pub async fn read(path: impl AsRef<Path>) -> std::io::Result<Option<Vec<EnvLine>>> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => Ok(Some(parse(&content))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn split_lines(content: &str) -> Vec<&str> {
    content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

fn parse_line(line: &str) -> EnvLine {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return EnvLine::Raw(line.to_string());
    }
    // **Matched against the untrimmed line on purpose.** An assignment that is
    // indented does not match the reference's anchored pattern either, so it
    // stays a raw line rather than becoming a value with a padded key.
    match split_assignment(line) {
        Some((key, raw_value)) => {
            let (value, quote) = unquote(raw_value);
            EnvLine::Pair {
                key: key.to_string(),
                value,
                quote,
            }
        }
        None => EnvLine::Raw(line.to_string()),
    }
}

/// `^([A-Za-z_][A-Za-z0-9_.]*)=(.*)$`, by hand.
fn split_assignment(line: &str) -> Option<(&str, &str)> {
    let equals = line.find('=')?;
    let key = &line[..equals];
    let mut characters = key.chars();
    let first = characters.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    if !characters.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
        return None;
    }
    Some((key, &line[equals + 1..]))
}

fn unquote(raw: &str) -> (String, Quote) {
    let characters: Vec<char> = raw.chars().collect();
    if characters.len() >= 2 {
        let first = characters[0];
        let last = characters[characters.len() - 1];
        let inner: String = characters[1..characters.len() - 1].iter().collect();
        if first == '"' && last == '"' {
            // Only these two escapes, matching the reference: a double-quoted
            // value is not run through a general unescaper.
            return (
                inner.replace("\\\"", "\"").replace("\\n", "\n"),
                Quote::Double,
            );
        }
        if first == '\'' && last == '\'' {
            return (inner, Quote::Single);
        }
    }
    (raw.to_string(), Quote::None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(content: &str) -> Vec<(String, String)> {
        entries(&parse(content))
            .into_iter()
            .map(|entry| (entry.key, entry.value))
            .collect()
    }

    #[test]
    fn keeps_assignments_and_drops_everything_else() {
        let parsed = pairs("# note\n\nFOO=bar\nnot an assignment\nPORT=3000\n");
        assert_eq!(
            parsed,
            vec![
                ("FOO".to_string(), "bar".to_string()),
                ("PORT".to_string(), "3000".to_string()),
            ]
        );
    }

    #[test]
    fn unquotes_both_quote_styles() {
        let parsed = pairs("A=\"double\"\nB='single'\nC=bare\n");
        assert_eq!(parsed[0].1, "double");
        assert_eq!(parsed[1].1, "single");
        assert_eq!(parsed[2].1, "bare");
    }

    #[test]
    fn a_double_quoted_value_takes_two_escapes() {
        let parsed = pairs("A=\"say \\\"hi\\\"\\nagain\"\n");
        assert_eq!(parsed[0].1, "say \"hi\"\nagain");
    }

    #[test]
    fn an_indented_assignment_is_not_one() {
        assert_eq!(pairs("  FOO=bar\n"), vec![]);
    }

    #[test]
    fn a_key_may_start_lowercase_or_underscore_but_not_a_digit() {
        assert_eq!(pairs("lower=1\n_under=2\n9bad=3\n").len(), 2);
    }

    #[test]
    fn a_value_may_contain_equals_signs() {
        assert_eq!(pairs("A=b=c\n"), vec![("A".to_string(), "b=c".to_string())]);
    }

    #[test]
    fn crlf_endings_lose_the_carriage_return() {
        assert_eq!(
            pairs("A=b\r\nC=d\r\n"),
            vec![
                ("A".to_string(), "b".to_string()),
                ("C".to_string(), "d".to_string()),
            ]
        );
    }
}
