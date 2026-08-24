//! How a route reads a request body.
//!
//! Both readers are deliberately lenient, because the reference's are: a body
//! that does not parse becomes an empty one, and the route then reports the
//! field it wanted rather than complaining about syntax. That is the message a
//! caller can act on — "name is required" tells you what to send, "invalid
//! JSON" does not tell you which field was wrong.

use axum::body::Bytes;
use serde_json::Value;
use std::collections::HashMap;

/// Read a JSON body the way the reference's `readJson` reads one: an empty,
/// unparsable, or non-object payload is `{}` rather than a refusal.
pub(crate) fn read_json_object(body: &Bytes) -> Value {
    let raw = std::str::from_utf8(body).unwrap_or_default().trim();
    if raw.is_empty() {
        return Value::Object(Default::default());
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(value) if value.is_object() || value.is_array() => value,
        // `null` parses but is not an object, and `typeof null === "object"`
        // does not save it: the reference's `parsed && typeof parsed` drops it.
        _ => Value::Object(Default::default()),
    }
}

pub(crate) fn string_field<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// Read an `application/x-www-form-urlencoded` body the way `URLSearchParams`
/// reads one: never fails, `+` is a space, and a repeated key keeps the first
/// value (which is what `URLSearchParams.get` returns). A body that is not a
/// form at all parses into keys nobody asks for, and the route then reports the
/// field it wanted — the same outcome the reference reaches.
pub(crate) fn parse_form(body: &Bytes) -> HashMap<String, String> {
    let raw = String::from_utf8_lossy(body);
    let mut form = HashMap::new();
    for pair in raw.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = match pair.split_once('=') {
            Some(split) => split,
            None => (pair, ""),
        };
        form.entry(percent_decode(key))
            .or_insert_with(|| percent_decode(value));
    }
    form
}

/// Percent-decoding with `+` as space. Invalid escapes are left as written,
/// the way a URL parser leaves a stray `%` alone rather than failing the body.
///
/// Decoding walks **bytes, not characters**. A `%` followed by part of a
/// multi-byte character (`%aé`) has two bytes after it but not two *chars*, and
/// slicing the string there would land inside the character and panic — turning
/// a malformed form body into a crashed request rather than a lenient parse.
pub(crate) fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => match hex_pair(bytes[index + 1], bytes[index + 2]) {
                Some(decoded) => {
                    out.push(decoded);
                    index += 3;
                }
                None => {
                    out.push(b'%');
                    index += 1;
                }
            },
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
    Some((hex_digit(high)? << 4) | hex_digit(low)?)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_escapes_and_plus() {
        assert_eq!(percent_decode("a+b%2Fc"), "a b/c");
        assert_eq!(percent_decode("%E2%9C%93"), "\u{2713}");
    }

    /// The regression this reader's byte walk exists for: a stray `%` in front
    /// of a multi-byte character used to slice the string mid-character.
    #[test]
    fn leaves_a_stray_escape_alone_without_panicking() {
        assert_eq!(percent_decode("%a\u{e9}"), "%a\u{e9}");
        assert_eq!(percent_decode("%"), "%");
        assert_eq!(percent_decode("%z1"), "%z1");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn a_repeated_key_keeps_the_first_value() {
        let form = parse_form(&Bytes::from_static(b"name=one&name=two"));
        assert_eq!(form.get("name").map(String::as_str), Some("one"));
    }
}
