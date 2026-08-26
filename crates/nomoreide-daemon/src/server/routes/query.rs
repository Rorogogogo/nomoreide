//! Reading a query string the way `URLSearchParams` reads one.
//!
//! Shared because more than one domain needs the same answers: the *first*
//! value for a repeated key rather than the last or a join, `+` as a space,
//! and a malformed escape replaced rather than thrown. Getting any of those
//! wrong is invisible until a client sends a repeated parameter.

use axum::http::Uri;

/// The first value for a query key, decoded the way `URLSearchParams` decodes
/// one: `+` is a space, a percent-escape is a byte, and a malformed escape is
/// replaced rather than thrown. A key present with no value is an empty string,
/// which is not the same as an absent key.
pub(crate) fn query_value(uri: &Uri, key: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        (decode_form(name) == key).then(|| decode_form(value))
    })
}

fn decode_form(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if raw
                .get(index + 1..index + 3)
                .is_some_and(|hex| hex.bytes().all(|byte| byte.is_ascii_hexdigit())) =>
            {
                decoded.push(u8::from_str_radix(&raw[index + 1..index + 3], 16).unwrap_or(b'%'));
                index += 3;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}
