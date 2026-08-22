//! Deciding what a log line is.
//!
//! Every rule here was read off the running reference rather than out of its
//! source, which is why some of them are shaped oddly. The error pattern has a
//! trailing word boundary and no leading one, so `terror` is an error and
//! `errors` is not; the log store's own severity classifier is a *different*
//! set of words (it counts `traceback`, this does not), and conflating the two
//! would change what an agent is shown.

use regex::Regex;
use std::sync::OnceLock;

/// How loudly a line reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Error,
    Warning,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

/// A file and line a stack frame pointed at. The path is reported exactly as
/// the frame spelled it — relative stays relative, and a path naming nothing
/// on disk is still what the program said went wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub file: String,
    pub line: u32,
}

/// The longest a title is kept. Past this a line is usually a serialized
/// payload rather than a message.
const TITLE_LIMIT: usize = 240;
/// The longest a signature is kept, after normalization has shortened it.
const SIGNATURE_LIMIT: usize = 200;

fn error_words() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    // No leading boundary: the reference matches `error` inside a longer word
    // but not when a letter follows it. Faithful, including that asymmetry.
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)(error|fatal|panic|exception|uncaught|unhandled|segmentation fault|eaddrinuse|econnrefused)\b",
        )
        .expect("valid error-word pattern")
    })
}

fn warning_words() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)(warn|warning|deprecated)\b").expect("valid pattern"))
}

/// A build that reports zero errors is announcing success. Only the count
/// itself is exempted — "no error" and "1 error" are still errors, because
/// only a literal zero is a claim that nothing went wrong.
fn zero_errors() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)\b0 errors?\b").expect("valid pattern"))
}

/// `path.ext:line:col` anywhere in the line, or Python's `File "path", line N`.
///
/// Two requirements, both of which a log line meets by accident far too often
/// without them: the path has to carry an extension, and a column has to
/// follow the line number. Without the extension `ECONNREFUSED 127.0.0.1:5432`
/// and an ISO instant both read as frames; without the column, so does every
/// `prefix:42` in the world.
fn frame_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?:File "([^"]+)", line (\d+))|([^\s()]+\.\w+):(\d+):\d+"#)
            .expect("valid frame pattern")
    })
}

/// Whether a line continues the stack trace above it.
///
/// Shape, not content: an indented `at …` or `File …` belongs to whatever was
/// reported before it, even when it names nothing this can resolve — a frame
/// in a language whose paths are not files is still part of the trace, and
/// dropping it would leave a stack with holes in it.
fn stack_continuation() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^\s+(?:at|File)\s").expect("valid continuation pattern"))
}

/// See [`stack_continuation`].
pub fn continues_a_stack(line: &str) -> bool {
    stack_continuation().is_match(line)
}

fn timestamps() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        // Case-insensitive because a signature is lowercased before it is
        // normalized, so the `T` and `Z` of an ISO instant arrive lowered.
        .get_or_init(|| Regex::new(r"(?i)\d{4}-\d{2}-\d{2}T[\d:.]+Z?").expect("valid pattern"))
}

fn hex_literals() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)0x[0-9a-f]+").expect("valid pattern"))
}

fn whole_numbers() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\b\d+\b").expect("valid pattern"))
}

fn runs_of_space() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\s+").expect("valid pattern"))
}

/// What level a line reads as, or nothing when it is ordinary output.
pub fn level_of(text: &str) -> Option<Level> {
    if error_words().is_match(text) && !zero_errors().is_match(text) {
        return Some(Level::Error);
    }
    if warning_words().is_match(text) {
        return Some(Level::Warning);
    }
    None
}

/// The line as an incident's title: trimmed, and cut where a message stops
/// being one. Cut by character rather than by byte so a multi-byte line is
/// still valid text afterwards.
pub fn title_of(text: &str) -> String {
    truncate(text.trim(), TITLE_LIMIT)
}

/// What makes two occurrences the same incident.
///
/// The service name is part of it, so the same message from two services is
/// two incidents. Everything that varies between occurrences of one fault —
/// timestamps, addresses, ids, counts — is replaced, which is what lets a
/// loop that fails a thousand times read as one thing that is wrong.
///
/// Built from the whole line rather than from the title: the title is cut at
/// 240 characters, and normalizing first means a long line of varying numbers
/// still signs by what it says rather than by where the title happened to end.
pub fn signature_of(service: &str, text: &str) -> String {
    let lowered = text.to_lowercase();
    let normalized = timestamps().replace_all(&lowered, "<ts>");
    let normalized = hex_literals().replace_all(&normalized, "<hex>");
    let normalized = whole_numbers().replace_all(&normalized, "<n>");
    let collapsed = runs_of_space().replace_all(normalized.trim(), " ");
    format!("{service} {}", truncate(&collapsed, SIGNATURE_LIMIT))
}

/// The last frame a run of lines pointed at, if any pointed anywhere.
///
/// The *last*, because a stack is printed innermost-first only in some
/// runtimes and the reference takes whichever came latest in the window it
/// looked at.
pub fn last_frame(lines: &[String]) -> Option<Frame> {
    lines.iter().rev().find_map(|line| frame_in(line))
}

/// The frame a single line names, if it names one.
pub fn frame_in(line: &str) -> Option<Frame> {
    let captures = frame_pattern().captures(line)?;
    let (file, number) = match (captures.get(1), captures.get(2)) {
        (Some(file), Some(number)) => (file.as_str(), number.as_str()),
        _ => (captures.get(3)?.as_str(), captures.get(4)?.as_str()),
    };
    Some(Frame {
        file: file.to_string(),
        line: number.parse().ok()?,
    })
}

fn truncate(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_error_word_has_a_trailing_boundary_and_no_leading_one() {
        assert_eq!(level_of("the terror of it all"), Some(Level::Error));
        assert_eq!(level_of("zzz errors zzz"), None);
        assert_eq!(level_of("zzz error_code zzz"), None);
        assert_eq!(level_of("zzz error-ish zzz"), Some(Level::Error));
    }

    #[test]
    fn only_a_literal_zero_count_is_read_as_success() {
        assert_eq!(level_of("0 errors"), None);
        assert_eq!(level_of("0 error"), None);
        assert_eq!(level_of("1 error"), Some(Level::Error));
        assert_eq!(level_of("no error"), Some(Level::Error));
        assert_eq!(level_of("00 error"), Some(Level::Error));
        // Warnings are never suppressed by an error count.
        assert_eq!(level_of("0 warn"), Some(Level::Warning));
    }

    #[test]
    fn an_error_outranks_a_warning_in_the_same_line() {
        assert_eq!(
            level_of("warning: this is an error too"),
            Some(Level::Error)
        );
    }

    #[test]
    fn a_signature_is_normalized_before_it_is_cut_not_after() {
        // Thirty groups collapse to thirty short ones, so the cut lands far
        // later in the message than a cut of the raw line would.
        let line = format!("Error: {}", "num 1234567890 ".repeat(30));
        let signature = signature_of("long", &line);
        assert_eq!(signature.chars().count(), 5 + SIGNATURE_LIMIT);
        assert_eq!(signature.matches("num <n>").count(), 24);
    }

    #[test]
    fn a_signature_forgets_what_varies_between_occurrences() {
        assert_eq!(
            signature_of("api", "Error: id 111 failed"),
            "api error: id <n> failed"
        );
        assert_eq!(
            signature_of("api", "Error at 2026-08-22T12:00:00.000Z"),
            "api error at <ts>"
        );
        assert_eq!(
            signature_of("api", "Error: took 12.5ms and 0x1f bytes"),
            "api error: took <n>.5ms and <hex> bytes"
        );
        assert_eq!(
            signature_of("api", "Error:    spaced    out"),
            "api error: spaced out"
        );
    }

    #[test]
    fn a_frame_needs_a_column_unless_python_wrote_it() {
        assert_eq!(
            frame_in("    at h (/tmp/app.js:5:1)"),
            Some(Frame {
                file: "/tmp/app.js".into(),
                line: 5
            })
        );
        assert_eq!(frame_in("    at h (/tmp/app.js:7)"), None);
        assert_eq!(
            frame_in(r#"  File "/tmp/app.js", line 11, in handler"#),
            Some(Frame {
                file: "/tmp/app.js".into(),
                line: 11
            })
        );
        assert_eq!(frame_in("\tat com.example.Main.run(Main.java:42)"), None);
    }

    #[test]
    fn a_frame_needs_an_extension_so_ordinary_colons_are_not_one() {
        assert_eq!(
            frame_in("    at h (app.js:5:1)"),
            Some(Frame {
                file: "app.js".into(),
                line: 5
            })
        );
        assert_eq!(
            frame_in("    at h (http://localhost:3000/x.js:2:1)"),
            Some(Frame {
                file: "http://localhost:3000/x.js".into(),
                line: 2
            })
        );
        // No extension, so not a path.
        assert_eq!(frame_in("    at h (/tmp/appjs:5:1)"), None);
        assert_eq!(frame_in("Error at 2026-08-22T13:00:00.000Z"), None);
        assert_eq!(frame_in("ECONNREFUSED 127.0.0.1:5432"), None);
    }

    #[test]
    fn a_stack_continues_through_frames_it_cannot_resolve() {
        assert!(continues_a_stack("    at somewhere unknown"));
        assert!(continues_a_stack("\tat com.example.Main.run(Main.java:42)"));
        assert!(continues_a_stack(
            r#"  File "/tmp/app.js", line 7, in handler"#
        ));
        assert!(!continues_a_stack("    just indented"));
        assert!(!continues_a_stack("          ^"));
        assert!(!continues_a_stack("plain unindented follower"));
        // `at` has to be indented: a message may well start with it.
        assert!(!continues_a_stack("at the start of a message"));
    }

    #[test]
    fn a_title_is_trimmed_and_cut_rather_than_ellipsized() {
        assert_eq!(
            title_of("   Error: leading spaces"),
            "Error: leading spaces"
        );
        let long = format!("Error: {}", "y".repeat(500));
        assert_eq!(title_of(&long).chars().count(), TITLE_LIMIT);
        assert!(!title_of(&long).ends_with('…'));
    }
}
