//! `String.prototype.localeCompare`, as far as this program needs it.
//!
//! The reference sorts several user-facing listings with `localeCompare`, which
//! is not byte order: it compares base letters first and only settles case at
//! the tertiary level, where *lower*case sorts first — the opposite of what the
//! code points say. A listing sorted by `cmp` puts `Zebra` before `apple`;
//! this puts `apple` first, which is what the person reading it expects.
//!
//! Only the part that separates ASCII case is reproduced. Full collation would
//! mean carrying ICU, and every listing sorted through here holds identifiers —
//! skill directories, MCP keys, plugin names — not prose in another script.

use std::cmp::Ordering;

pub fn compare(left: &str, right: &str) -> Ordering {
    match left.to_lowercase().cmp(&right.to_lowercase()) {
        Ordering::Equal => right.cmp(left),
        primary => primary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_does_not_decide_before_the_letters_do() {
        assert_eq!(compare("apple", "Zebra"), Ordering::Less);
        assert_eq!(compare("Zebra", "apple"), Ordering::Greater);
    }

    #[test]
    fn lowercase_wins_a_tie() {
        assert_eq!(compare("a", "A"), Ordering::Less);
        assert_eq!(compare("A", "a"), Ordering::Greater);
        assert_eq!(compare("a", "a"), Ordering::Equal);
    }
}
