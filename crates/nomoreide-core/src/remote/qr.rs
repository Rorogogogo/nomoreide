//! The QR code that gets a pairing link from a screen onto a phone.
//!
//! **Why this is in the daemon rather than in each front door.** Pairing is
//! offered in three places — the CLI prints a code, the dashboard shows one,
//! and the desktop app will — and a QR is a thing each of them could have
//! grown its own copy of: a Rust crate for the terminal, an npm package for
//! the browser, a third for Tauri. That is the shape this repository already
//! paid for once in the desktop app's 150 duplicated commands.
//!
//! So the encoding happens once, here, and what crosses to a renderer is the
//! **module matrix** — a grid of light and dark squares. The terminal draws it
//! in half-blocks, the dashboard draws it as an SVG it builds itself, and
//! neither needs a QR library or agrees with the other by accident. A matrix is
//! also the cheapest possible thing to send: a version-6 code is 41×41, which
//! is 41 short strings.
//!
//! Nothing here is a secret. A pairing link is meant to be photographed off a
//! screen — the short code beneath it is what the platform rate-limits, and the
//! account approving it is what makes either safe.

use qrcode::{EcLevel, QrCode};
use serde::{Deserialize, Serialize};

/// The error correction level.
///
/// Medium, not low: this is photographed off a glowing screen at an angle, in
/// whatever light the room has, often through a terminal's own font rendering.
/// The extra modules cost a slightly denser grid and buy back the scans that
/// would otherwise need a second try.
const ERROR_CORRECTION: EcLevel = EcLevel::M;

/// The quiet zone, in modules, on every side.
///
/// Four is what the specification requires, and it is not decoration: a scanner
/// finds the code by its border, so a QR flush against a panel edge or a
/// terminal's background is one many phones simply never see.
const QUIET_ZONE: usize = 4;

/// A rendered QR code, as squares rather than as pixels.
///
/// `rows` is one string per row, `'1'` for a dark module and `'0'` for a light
/// one — a shape that is unambiguous in JSON, diffable in a test, and readable
/// in a failure message. The quiet zone is already included, so a renderer that
/// draws exactly what it is given is correct by default rather than correct
/// only if it remembered the margin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    /// Width and height in modules, quiet zone included. Always square.
    pub size: usize,
    pub rows: Vec<String>,
}

impl QrMatrix {
    /// Whether the module at `(row, column)` is dark. Out of range is light,
    /// so a renderer that overdraws its own border cannot panic.
    pub fn is_dark(&self, row: usize, column: usize) -> bool {
        self.rows
            .get(row)
            .and_then(|line| line.as_bytes().get(column))
            .is_some_and(|module| *module == b'1')
    }

    /// The code as text for a terminal, two rows of modules per line.
    ///
    /// Half-blocks rather than a full block per module, because a terminal cell
    /// is about twice as tall as it is wide: one character per module produces
    /// a rectangle a phone reads as a distorted code, and two modules stacked
    /// into one cell comes out square. Each line is one character per column,
    /// so a 41-module code fits an 80-column terminal with room to spare.
    ///
    /// Drawn **dark-on-light**, always — the modules are the foreground and the
    /// quiet zone is the background, whatever colours the terminal has. A code
    /// inverted by a light-background theme is one no scanner will read, and
    /// this cannot know the theme.
    pub fn to_half_blocks(&self) -> String {
        let mut out = String::new();
        for pair in (0..self.size).step_by(2) {
            for column in 0..self.size {
                let upper = self.is_dark(pair, column);
                // An odd-height matrix leaves the last line with no lower row.
                // It is quiet zone, so light is the right answer rather than a
                // truncation.
                let lower = self.is_dark(pair + 1, column);
                out.push(match (upper, lower) {
                    (true, true) => '█',
                    (true, false) => '▀',
                    (false, true) => '▄',
                    (false, false) => ' ',
                });
            }
            out.push('\n');
        }
        out
    }
}

/// Encode `text`, or nothing if it will not fit a QR code at all.
///
/// `None` rather than an error: a QR is an accelerant, never the only way in.
/// Every caller shows the code and the link regardless, so a pairing link too
/// long to encode costs a convenience and not a feature — and a pairing screen
/// that refused to appear because a picture of it could not be drawn would be a
/// much worse trade.
pub fn encode(text: &str) -> Option<QrMatrix> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), ERROR_CORRECTION).ok()?;
    let colors = code.to_colors();
    let width = code.width();
    let size = width + QUIET_ZONE * 2;

    let mut rows = Vec::with_capacity(size);
    for row in 0..size {
        let mut line = String::with_capacity(size);
        for column in 0..size {
            let inside = row >= QUIET_ZONE
                && column >= QUIET_ZONE
                && row < QUIET_ZONE + width
                && column < QUIET_ZONE + width;
            let dark = inside
                && colors[(row - QUIET_ZONE) * width + (column - QUIET_ZONE)]
                    == qrcode::Color::Dark;
            line.push(if dark { '1' } else { '0' });
        }
        rows.push(line);
    }
    Some(QrMatrix { size, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: &str = "https://www.nomoreide.com/app/remote/pair?code=ABCD-EFGH";

    #[test]
    fn a_pairing_link_encodes_to_a_square_matrix() {
        let matrix = encode(LINK).expect("a pairing link fits a QR code");
        assert_eq!(matrix.rows.len(), matrix.size);
        for row in &matrix.rows {
            assert_eq!(row.chars().count(), matrix.size, "{row}");
            assert!(row.chars().all(|module| module == '0' || module == '1'));
        }
    }

    /// The border is the thing a scanner finds the code by. A matrix that
    /// arrives without one is a matrix every renderer has to remember to add,
    /// and one of them will not.
    #[test]
    fn the_quiet_zone_is_already_in_the_matrix() {
        let matrix = encode(LINK).expect("encode");
        for edge in 0..QUIET_ZONE {
            assert!(
                matrix.rows[edge].bytes().all(|module| module == b'0'),
                "row {edge} is not quiet"
            );
            let bottom = matrix.size - 1 - edge;
            assert!(
                matrix.rows[bottom].bytes().all(|module| module == b'0'),
                "row {bottom} is not quiet"
            );
            for row in &matrix.rows {
                assert_eq!(row.as_bytes()[edge], b'0');
                assert_eq!(row.as_bytes()[matrix.size - 1 - edge], b'0');
            }
        }
        // ...and something is actually drawn inside it.
        assert!(matrix
            .rows
            .iter()
            .any(|row| row.bytes().any(|module| module == b'1')));
    }

    /// One terminal line per *two* module rows, and one character per column.
    /// A code that comes out twice as tall as it is wide is one a phone reads
    /// as a distorted square, which is the whole reason for half-blocks.
    #[test]
    fn the_terminal_rendering_is_square_and_fits_eighty_columns() {
        let matrix = encode(LINK).expect("encode");
        let drawn = matrix.to_half_blocks();
        let lines: Vec<&str> = drawn.lines().collect();
        assert_eq!(lines.len(), matrix.size.div_ceil(2));
        for line in &lines {
            assert_eq!(line.chars().count(), matrix.size);
        }
        assert!(matrix.size <= 80, "a pairing QR must fit a terminal");
    }

    /// An odd-height matrix has no lower row for its last line. That row is
    /// quiet zone, so it must draw as light rather than run off the end.
    #[test]
    fn an_odd_height_matrix_does_not_read_past_its_last_row() {
        let matrix = QrMatrix {
            size: 3,
            rows: vec!["101".into(), "010".into(), "101".into()],
        };
        assert_eq!(matrix.to_half_blocks(), "▀▄▀\n▀ ▀\n");
    }

    #[test]
    fn out_of_range_modules_are_light_rather_than_a_panic() {
        let matrix = encode(LINK).expect("encode");
        assert!(!matrix.is_dark(matrix.size + 10, 0));
        assert!(!matrix.is_dark(0, matrix.size + 10));
    }

    /// A link long enough to defeat the encoder must cost the picture, not the
    /// pairing.
    #[test]
    fn something_too_long_to_encode_is_none_rather_than_a_failure() {
        assert!(encode(&"x".repeat(8_000)).is_none());
    }
}
