//! `JSON.parse` failures, worded the way V8 words them.
//!
//! One route hands a client-supplied JSON *string* to a parser and lets the
//! failure escape as the response's error message: the row browser's `filters`
//! query parameter. The reference is Node, so that message is V8's parser
//! diagnostic, and a client that shows it to a person shows V8's wording. This
//! module reproduces that wording from `serde_json`'s.
//!
//! It is a translation of one parser's diagnostics into another's, not a
//! parser, so it covers the shapes a malformed parameter actually arrives in
//! and no more:
//!
//! | input | message |
//! | --- | --- |
//! | truncated or empty | `Unexpected end of JSON input` |
//! | a character no value can start with | `Unexpected token 'x', "…" is not valid JSON` |
//! | anything after a complete value | `Unexpected non-whitespace character after JSON at position N` |
//! | a string with no closing quote | `Unterminated string in JSON at position N` |
//! | a missing `,` or `]` between array elements | `Expected ',' or ']' after array element in JSON at position N` |
//! | a key that is not a string | `Expected property name or '}' in JSON at position N` |
//!
//! Anything else falls back to the unexpected-token wording, which is V8's own
//! most common answer. Positions are counted in **characters**; V8 counts UTF-16
//! code units, so a message pointing past an astral character would differ.
//! Every row of the table above is a case in the catalog parity gate.
//!
//! **Where this stops, on purpose.** A document that runs out *inside a
//! container* is the one family not reproduced. V8 words those by what the
//! parser was waiting for — a property name, a `:`, a `,` or `]`, a `,` or `}` —
//! and `serde_json` reports only which container was open, so telling `[1` from
//! `["a"` from `{"a"` would mean writing a second JSON scanner to recover a
//! parse state. Those all answer `Unexpected end of JSON input` here. The
//! status, the `ok: false`, and the shape are identical either way; only the
//! sentence differs, and only for a `filters` value no client builds — the
//! dashboard sends `JSON.stringify` output, which never truncates.

use serde_json::Value;

/// `JSON.parse(raw)`, with V8's message on failure.
pub(crate) fn parse(raw: &str) -> Result<Value, String> {
    serde_json::from_str(raw).map_err(|error| message(raw, &error))
}

fn message(raw: &str, error: &serde_json::Error) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let position = position_of(&chars, error.line(), error.column());
    // `classify` reports Eof for a value that simply ran out, and for a string
    // that ran out — which V8 words differently, so the wording is chosen from
    // serde's text before its category.
    let text = error.to_string();
    if text.starts_with("EOF while parsing a string") {
        // The string ran to the end of the document, so that is where V8 points
        // -- one past serde's last character, not at it.
        return format!("Unterminated string in JSON {}", at(&chars, chars.len()));
    }
    if error.classify() == serde_json::error::Category::Eof {
        return "Unexpected end of JSON input".to_string();
    }
    if text.starts_with("trailing characters") {
        return format!(
            "Unexpected non-whitespace character after JSON {}",
            at(&chars, position)
        );
    }
    if text.starts_with("expected `,` or `]`") {
        return format!(
            "Expected ',' or ']' after array element in JSON {}",
            at(&chars, position)
        );
    }
    if text.starts_with("key must be a string") {
        return format!(
            "Expected property name or '}}' in JSON {}",
            at(&chars, position)
        );
    }
    match chars.get(position) {
        Some(token) => format!(
            "Unexpected token '{token}', {} is not valid JSON",
            snippet(&chars, position)
        ),
        None => "Unexpected end of JSON input".to_string(),
    }
}

/// The character index serde's one-based line and column point at.
fn position_of(chars: &[char], line: usize, column: usize) -> usize {
    let mut index = 0;
    for _ in 1..line {
        match chars[index..]
            .iter()
            .position(|character| *character == '\n')
        {
            Some(offset) => index += offset + 1,
            None => return chars.len(),
        }
    }
    (index + column.saturating_sub(1)).min(chars.len())
}

/// V8 prints a position twice: once counting from zero, once as a line and a
/// column counting from one.
fn at(chars: &[char], position: usize) -> String {
    let mut line = 1;
    let mut column = 1;
    for character in &chars[..position.min(chars.len())] {
        if *character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    format!("at position {position} (line {line} column {column})")
}

/// The offending text, quoted the way V8 quotes it.
///
/// A short document is shown whole. A long one is shown through a window of ten
/// characters either side of the offending one, with an ellipsis on whichever
/// end the window does not reach. The text inside the quotes is raw — a newline
/// in the source is a newline in the message, not an escape.
fn snippet(chars: &[char], position: usize) -> String {
    if chars.len() <= 20 {
        return format!("\"{}\"", chars.iter().collect::<String>());
    }
    let start = position.saturating_sub(10);
    let end = (position + 10).min(chars.len());
    let window: String = chars[start..end].iter().collect();
    format!(
        "{}\"{window}\"{}",
        if start > 0 { "..." } else { "" },
        if end < chars.len() { "..." } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every message here was read off a live `node -e 'JSON.parse(...)'`, not
    /// written from the shape of the code.
    fn failure(raw: &str) -> String {
        parse(raw).expect_err(raw)
    }

    #[test]
    fn says_what_v8_says() {
        assert_eq!(
            failure("oops"),
            "Unexpected token 'o', \"oops\" is not valid JSON"
        );
        assert_eq!(
            failure("[1,x]"),
            "Unexpected token 'x', \"[1,x]\" is not valid JSON"
        );
        assert_eq!(
            failure("@"),
            "Unexpected token '@', \"@\" is not valid JSON"
        );
        assert_eq!(
            failure("[1,2,]"),
            "Unexpected token ']', \"[1,2,]\" is not valid JSON"
        );
    }

    #[test]
    fn a_document_that_ran_out_has_no_position() {
        for raw in ["", "   ", "[", "[1,", "nul", "tru"] {
            assert_eq!(failure(raw), "Unexpected end of JSON input", "{raw:?}");
        }
    }

    #[test]
    fn content_after_a_complete_value_is_its_own_complaint() {
        assert_eq!(
            failure("[1] x"),
            "Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)"
        );
        assert_eq!(
            failure("[1]]"),
            "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)"
        );
        assert_eq!(
            failure("[1,2]junk"),
            "Unexpected non-whitespace character after JSON at position 5 (line 1 column 6)"
        );
    }

    #[test]
    fn the_named_syntax_failures() {
        assert_eq!(
            failure("\"unterminated"),
            "Unterminated string in JSON at position 13 (line 1 column 14)"
        );
        assert_eq!(
            failure("[\"a"),
            "Unterminated string in JSON at position 3 (line 1 column 4)"
        );
        assert_eq!(
            failure("[1,\"a\"o]"),
            "Expected ',' or ']' after array element in JSON at position 6 (line 1 column 7)"
        );
        assert_eq!(
            failure("{a:1}"),
            "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
        );
    }

    /// Twenty characters is the whole document; twenty-one is a window.
    #[test]
    fn the_window_opens_at_twenty_one_characters() {
        assert_eq!(
            failure(&"x".repeat(20)),
            format!(
                "Unexpected token 'x', \"{}\" is not valid JSON",
                "x".repeat(20)
            )
        );
        assert_eq!(
            failure(&"x".repeat(21)),
            "Unexpected token 'x', \"xxxxxxxxxx\"... is not valid JSON"
        );
        assert_eq!(
            failure(&format!("[{}@]", "1,".repeat(9))),
            "Unexpected token '@', ...\"1,1,1,1,1,@]\" is not valid JSON"
        );
    }

    /// A newline inside the snippet is printed as a newline.
    #[test]
    fn a_multi_line_document_reports_a_multi_line_snippet() {
        assert_eq!(
            failure("[\n1,\noops\n]"),
            "Unexpected token 'o', \"[\n1,\noops\n]\" is not valid JSON"
        );
    }

    #[test]
    fn a_document_that_parses_comes_back_parsed() {
        assert_eq!(parse("[1,2]").unwrap(), serde_json::json!([1, 2]));
    }
}
