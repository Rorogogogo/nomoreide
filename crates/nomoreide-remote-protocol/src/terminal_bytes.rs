//! Raw PTY bytes on a JSON wire.
//!
//! **Why this type exists at all.** Everything else the protocol carries is
//! text the daemon composed — a service name, a log line it already decoded. A
//! terminal is different: it is whatever the child wrote, and that is not
//! UTF-8. A cursor move is bytes; a repaint is bytes; a `read()` that lands in
//! the middle of a multi-byte character is bytes with half a character at each
//! end. Passing that through `String::from_utf8_lossy` — the way log lines are
//! handled — replaces the offending bytes with `U+FFFD`, and a replacement
//! character in an escape sequence does not render as a slightly wrong screen.
//! It renders as garbage, and the next sequence is misparsed too.
//!
//! So the payload is base64, and this type is the one place that is decided.
//! Serialising is infallible; deserialising rejects anything that is not
//! base64, which is what keeps the failure at the protocol boundary instead of
//! several layers into a terminal emulator.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A chunk of PTY traffic, base64 on the wire and bytes in memory.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalBytes(pub Vec<u8>);

impl TerminalBytes {
    pub fn new(data: impl Into<Vec<u8>>) -> Self {
        Self(data.into())
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for TerminalBytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for TerminalBytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let encoded = String::deserialize(deserializer)?;
        STANDARD
            .decode(encoded.as_bytes())
            .map(Self)
            .map_err(|error| D::Error::custom(format!("terminal data is not base64: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the whole type is for: bytes that are not valid UTF-8
    /// survive the round trip unchanged. A lossy string would not.
    #[test]
    fn invalid_utf8_survives_the_round_trip() {
        let raw = vec![0x1b, b'[', b'2', b'J', 0xff, 0xfe, 0x00, b'x'];
        let json = serde_json::to_string(&TerminalBytes::new(raw.clone())).unwrap();
        let back: TerminalBytes = serde_json::from_str(&json).unwrap();

        assert_eq!(back.as_slice(), raw.as_slice());
        assert_ne!(
            String::from_utf8_lossy(&raw).as_bytes(),
            raw.as_slice(),
            "the bytes chosen must actually be the case a lossy decode would ruin"
        );
    }

    #[test]
    fn it_is_a_json_string_not_an_array_of_numbers() {
        let json = serde_json::to_string(&TerminalBytes::new(b"hi".to_vec())).unwrap();
        assert_eq!(json, "\"aGk=\"");
    }

    #[test]
    fn anything_that_is_not_base64_is_refused_at_the_boundary() {
        assert!(serde_json::from_str::<TerminalBytes>("\"not base64!!\"").is_err());
        assert!(serde_json::from_str::<TerminalBytes>("[104,105]").is_err());
    }
}
