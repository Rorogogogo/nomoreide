//! `String.prototype.localeCompare`, as far as this program needs it.
//!
//! The reference sorts several user-facing listings with `localeCompare`, which
//! is not byte order: it compares base letters first and only settles case at
//! the tertiary level, where *lower*case sorts first — the opposite of what the
//! code points say. A listing sorted by `cmp` puts `Zebra` before `apple`;
//! this puts `apple` first, which is what the person reading it expects.
//!
//! Two levels and a tiebreak, not full collation: enough to fold a Latin-1
//! accent, to rank punctuation by its collation group rather than its code
//! point, and to settle case the way ICU settles it. Carrying ICU for the
//! handful of listings that need this is not worth it.

use std::cmp::Ordering;

/// `String.prototype.localeCompare`, to the depth these listings need.
///
/// **This is an approximation of ICU's collation, not an implementation of
/// it.** Two levels and a tiebreak:
///
/// 1. *Primary* — punctuation ranked by its collation group, everything else
///    by its accent-folded lowercase code point. This is what puts `alpha`
///    before `Beta` where a byte comparison puts `Beta` first, what keeps
///    `éclair` beside `eclair` instead of after `zeta`, and what puts `_under`
///    before `.hidden`.
/// 2. *Case* — lowercase first, for names equal through the primary level.
/// 3. Whatever is left is settled by code point.
///
/// There is deliberately **no accent level** between those two. It would never
/// decide anything: an accented character's code point is always above its
/// base, so for any two names that tie on the folded primary the code-point
/// tiebreak already orders them the way the accent would.
///
/// Names outside Latin-1 fold to themselves, which is where this parts company
/// with ICU. Every caller sorts names — directories, SSH hosts, MCP keys, skill
/// directories, public keys — and the alternative is an ICU dependency for a
/// handful of listings.
pub fn compare(left: &str, right: &str) -> Ordering {
    for level in 0..2 {
        let ordering = sort_key(left, level).cmp(&sort_key(right, level));
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.cmp(right)
}

fn sort_key(value: &str, level: usize) -> Vec<u32> {
    value
        .chars()
        .map(|character| match level {
            0 => {
                let base = fold(character);
                // Two classes, not three: punctuation is ranked by its
                // collation group, and everything else by its folded lowercase
                // code point. A separate class for digits would be redundant —
                // every digit's code point already sorts below every letter's.
                let (class, weight) = if base.is_alphanumeric() {
                    (1, base.to_lowercase().next().unwrap_or(base) as u32)
                } else {
                    (0, punctuation_rank(base))
                };
                (class << 24) | weight
            }
            _ => u32::from(character.is_uppercase()),
        })
        .collect()
}

/// Where a punctuation mark sorts *relative to other punctuation*.
///
/// Not its code point: the collation orders these by their group in the default
/// table, so an underscore comes before a full stop even though `.` is the
/// lower code point. That one pair is the whole reason this table exists —
/// `_under` sorts before `.hidden`, and a code-point comparison gets it
/// backwards. Anything not listed keeps its code point, offset past the table
/// so it sorts after everything named here.
fn punctuation_rank(character: char) -> u32 {
    const ORDER: [char; 26] = [
        ' ', '_', '-', ',', ';', ':', '!', '?', '.', '\'', '"', '(', ')', '[', ']', '{', '}', '@',
        '*', '/', '\\', '&', '#', '%', '+', '=',
    ];
    match ORDER.iter().position(|entry| *entry == character) {
        Some(index) => index as u32,
        None => ORDER.len() as u32 + character as u32,
    }
}

/// Strip a Latin-1 accent down to its base letter. Anything else is itself.
fn fold(character: char) -> char {
    match character {
        'à'..='å' | 'À'..='Å' => 'a',
        'è'..='ë' | 'È'..='Ë' => 'e',
        'ì'..='ï' | 'Ì'..='Ï' => 'i',
        'ò'..='ö' | 'Ò'..='Ö' => 'o',
        'ù'..='ü' | 'Ù'..='Ü' => 'u',
        'ç' | 'Ç' => 'c',
        'ñ' | 'Ñ' => 'n',
        'ý' | 'ÿ' | 'Ý' => 'y',
        other => other,
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
    fn an_accent_does_not_push_a_name_past_the_alphabet() {
        // The reason this replaced a byte comparison: `é` is `e` at the primary
        // level, so `éclair` belongs beside `eclair` rather than after `zeta`.
        assert_eq!(compare("\u{e9}clair", "gamma"), Ordering::Less);
        assert_eq!(compare("eclair", "\u{e9}clair"), Ordering::Less);
    }

    #[test]
    fn punctuation_sorts_by_its_group_rather_than_its_code_point() {
        // `_` is the lower rank even though `.` is the lower code point.
        assert_eq!(compare("_work.pub", ".hidden"), Ordering::Less);
        assert_eq!(compare("_work.pub", "Backup.pub"), Ordering::Less);
    }

    #[test]
    fn lowercase_wins_a_tie() {
        assert_eq!(compare("a", "A"), Ordering::Less);
        assert_eq!(compare("A", "a"), Ordering::Greater);
        assert_eq!(compare("a", "a"), Ordering::Equal);
    }
}

/// `<`, `>` and `>=` between two JavaScript strings.
///
/// Not the collator above: the relational operators do not consult one. They
/// compare UTF-16 code units, which is why they order ASCII the obvious way and
/// order everything else by encoding rather than by alphabet. Two places need
/// exactly that — picking the latest `timestamp` out of a rollout, and the
/// `since` filter on usage history — and both would be subtly wrong if they
/// used the collator or Rust's own byte order.
///
/// Rust compares `str` by UTF-8 bytes, which agrees with UTF-16 for everything
/// below U+E000 and disagrees above it: a supplementary character encodes as a
/// surrogate pair beginning `0xD800`, which sorts *below* the `0xE000` range
/// rather than above it.
pub fn code_unit_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod relational_tests {
    use super::code_unit_cmp;
    use std::cmp::Ordering;

    #[test]
    fn ascii_orders_the_obvious_way() {
        assert_eq!(code_unit_cmp("2026-08-20", "2026-08-21"), Ordering::Less);
        assert_eq!(code_unit_cmp("b", "a"), Ordering::Greater);
        assert_eq!(code_unit_cmp("", ""), Ordering::Equal);
        assert_eq!(code_unit_cmp("2026", "2026-08"), Ordering::Less);
    }

    #[test]
    fn a_supplementary_character_sorts_below_the_private_use_area() {
        // Rust's own byte order puts these the other way round.
        assert_eq!(code_unit_cmp("\u{1F600}", "\u{E000}"), Ordering::Less);
        assert!("\u{1F600}" > "\u{E000}");
    }
}
