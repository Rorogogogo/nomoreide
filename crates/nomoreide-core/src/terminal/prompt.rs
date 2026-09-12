//! Whether a session is sitting on a numbered menu, read from its raw output.
//!
//! **This is advisory, and the difference matters.** The phone's own reader
//! works from xterm's parsed grid — a real emulator, with the cursor moves
//! applied — and that is what draws the approval buttons somebody actually
//! presses. This one has only the bytes, because the daemon is the only thing
//! that can see a session *nobody is attached to*, and that is exactly when the
//! question "is it waiting for me?" is worth asking.
//!
//! So it answers for a badge, never for an action. A missed prompt shows a row
//! that says "Working" a little too long; it cannot cause the wrong thing to be
//! approved, because approving still happens on the real grid.
//!
//! **Why not parse properly.** Doing this exactly means embedding a VT emulator
//! in the daemon — cursor addressing, scroll regions, alternate screens — to
//! render a frame we then read three lines of. That is a large dependency and a
//! large surface for a status line, and it would be a second emulator to keep
//! in step with the one the phone already runs.

/// How much of the tail to look at.
///
/// A repainting TUI rewrites its whole box on every frame, so the last screen
/// is near the end by construction. Eight kilobytes is several frames of one —
/// enough that a prompt drawn just before the agent went quiet is still in
/// view, and small enough to scan on every listing.
const TAIL_BYTES: usize = 8 * 1024;

/// How many trailing lines count as "the screen".
///
/// The same window the phone's reader uses, for the same reason: longer than
/// any menu worth tapping, short enough that prose further up cannot wander in.
const PROMPT_WINDOW: usize = 14;

/// Whether the tail of a session's output ends in a numbered menu.
///
/// Two or more consecutive numbered lines, the way every agent CLI draws a
/// permission prompt. One is a list, not a question — the same threshold the
/// phone's reader uses, and for the same reason.
pub fn awaiting_choice(output: &[u8]) -> bool {
    let tail = &output[output.len().saturating_sub(TAIL_BYTES)..];
    let text = strip_ansi(tail);
    let lines: Vec<&str> = text.lines().collect();
    let window = &lines[lines.len().saturating_sub(PROMPT_WINDOW)..];

    let mut choices = 0usize;
    for line in window {
        if choice_digit(line).is_some() {
            choices += 1;
            if choices >= 2 {
                return true;
            }
            continue;
        }
        // A non-empty line between options ends the run, so two unrelated
        // numbered lines with prose between them are not a menu.
        if choices > 0 && !line.trim().is_empty() {
            choices = 0;
        }
    }
    false
}

/// The digit a line offers, if the line is `1. Yes`, `❯ 2) No` or similar.
fn choice_digit(line: &str) -> Option<char> {
    let mut rest = line.trim_start();
    // The cursor marker, when the program is sitting on this option.
    for marker in ['❯', '>', '*'] {
        if let Some(stripped) = rest.strip_prefix(marker) {
            rest = stripped.trim_start();
            break;
        }
    }
    let mut chars = rest.chars();
    let digit = chars.next().filter(char::is_ascii_digit)?;
    let separator = chars.next().filter(|it| *it == '.' || *it == ')')?;
    let _ = separator;
    // Something has to follow, or this is a bare number rather than an option.
    let label = chars.as_str().trim();
    if label.is_empty() {
        return None;
    }
    Some(digit)
}

/// The printable text of a byte stream, with the escape sequences removed.
///
/// Lossy on purpose, in both senses: invalid UTF-8 becomes replacement
/// characters rather than an error, and cursor movement is *dropped* rather
/// than applied — so what comes out is the order the bytes were written, which
/// is not always the order they appear on screen. For a menu, drawn top to
/// bottom in one pass, those are the same.
fn strip_ansi(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            out.push(character);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte in `@`..`~`.
            Some('[') => {
                for inner in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&inner) {
                        break;
                    }
                }
            }
            // OSC: runs until BEL or ST (`ESC \`).
            Some(']') => {
                while let Some(inner) = chars.next() {
                    if inner == '\u{7}' {
                        break;
                    }
                    if inner == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-character escapes, and anything unrecognised: the one
            // character after ESC is consumed and nothing is emitted.
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{awaiting_choice, strip_ansi};

    /// The shape every agent CLI draws a permission prompt in.
    #[test]
    fn two_numbered_options_are_a_prompt() {
        let screen =
            b"Do you want to make this edit?\r\n\r\n 1. Yes\r\n 2. No, tell Claude what to do\r\n";
        assert!(awaiting_choice(screen));
    }

    /// The cursor marker is part of the drawing, not part of the question.
    #[test]
    fn the_selected_option_still_counts() {
        let screen = "Approve?\r\n\u{1b}[32m\u{1b}[1m 1. Yes\u{1b}[0m\r\n 2. No\r\n".as_bytes();
        assert!(awaiting_choice(screen));
    }

    /// One option is a list, not a question — the threshold the phone uses.
    #[test]
    fn a_single_numbered_line_is_not_a_prompt() {
        assert!(!awaiting_choice(
            b"Steps:\r\n 1. Install the thing\r\n\r\nDone.\r\n"
        ));
    }

    /// An agent mid-thought is the common case, and it must not read as
    /// waiting — a badge that is always on says nothing.
    #[test]
    fn a_working_agent_is_not_waiting() {
        let screen =
            "\u{1b}[2K\r\u{1b}[38;5;242m⠴ Thinking… (12s · esc to interrupt)\u{1b}[0m".as_bytes();
        assert!(!awaiting_choice(screen));
    }

    /// Prose between two numbered lines means they are not one menu.
    #[test]
    fn numbers_with_prose_between_them_are_not_a_menu() {
        let screen = b"1. First we ran the tests\r\nThey passed, so then\r\n2. We shipped it\r\n";
        assert!(!awaiting_choice(screen));
    }

    /// Only the end of the output counts. A prompt answered a thousand lines
    /// ago is not a prompt now, and the ring holds a megabyte of them.
    #[test]
    fn an_old_prompt_scrolled_away_does_not_count() {
        let mut screen = b" 1. Yes\r\n 2. No\r\n".to_vec();
        screen.extend(std::iter::repeat_n(b'\n', 200));
        screen.extend_from_slice(b"all done\r\n");
        assert!(!awaiting_choice(&screen));
    }

    #[test]
    fn an_empty_session_is_not_waiting() {
        assert!(!awaiting_choice(b""));
    }

    #[test]
    fn escape_sequences_leave_only_their_text() {
        assert_eq!(strip_ansi(b"\x1b[1;31mred\x1b[0m plain"), "red plain");
        assert_eq!(strip_ansi(b"\x1b]0;a title\x07text"), "text");
        assert_eq!(strip_ansi(b"\x1b]0;a title\x1b\\text"), "text");
    }
}
