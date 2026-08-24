//! Reading a query parameter the way the reference reads one.
//!
//! Most of the daemon's query values are clamped into a range before they are
//! used, so how exactly a half-typed number parses never escapes. The GitHub
//! routes are different: a `page` goes straight into the URL of a request to
//! GitHub, so whatever `Number()` made of it is what GitHub is asked for — and
//! the two runtimes have to ask for the same thing.

/// `Number(value)` for a query parameter, where an absent one is `null` and
/// `Number(null)` is `0`.
///
/// Deliberately *not* Rust's own float parse. The two disagree at both ends:
/// Rust accepts `inf` and `nan`, which JavaScript reads as not-a-number, and
/// JavaScript accepts the `0x`/`0o`/`0b` literal forms and the word
/// `Infinity`, which Rust does not.
pub(crate) fn js_number(value: Option<&str>) -> f64 {
    let Some(raw) = value else {
        return 0.0;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if digits == "Infinity" {
        return sign * f64::INFINITY;
    }
    // The radix literals are unsigned in JavaScript: `Number("-0x10")` is NaN,
    // not -16.
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return match i64::from_str_radix(rest, radix) {
                Ok(parsed) if !rest.is_empty() => parsed as f64,
                _ => f64::NAN,
            };
        }
    }
    // Everything Rust would take that JavaScript would not.
    if digits
        .chars()
        .any(|character| matches!(character, 'i' | 'I' | 'n' | 'N'))
    {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value) || fallback` — the idiom every one of these routes uses, in
/// which `0` and `NaN` both mean "not given".
pub(crate) fn js_number_or(value: Option<&str>, fallback: f64) -> f64 {
    let parsed = js_number(value);
    if parsed == 0.0 || parsed.is_nan() {
        fallback
    } else {
        parsed
    }
}

/// `String(number)`, for a value on its way into a URL.
///
/// A whole number prints without a decimal point, which is the difference that
/// matters here: Rust's own `{}` would render `2` as `2` too, but `2.0` as
/// `2`, and JavaScript agrees — the case they part company on is the very
/// large and the very small, where JavaScript switches to exponent notation.
pub(crate) fn js_number_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_string();
    }
    if number.fract() == 0.0 && number.abs() < 1e21 {
        return format!("{number:.0}");
    }
    format!("{number}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_javascript_reads() {
        assert_eq!(js_number(None), 0.0);
        assert_eq!(js_number(Some("")), 0.0);
        assert_eq!(js_number(Some("   ")), 0.0);
        assert_eq!(js_number(Some(" 4 ")), 4.0);
        assert_eq!(js_number(Some("2.7")), 2.7);
        assert_eq!(js_number(Some("-3")), -3.0);
        assert_eq!(js_number(Some("1e2")), 100.0);
        assert_eq!(js_number(Some("0x10")), 16.0);
        assert!(js_number(Some("abc")).is_nan());
        assert!(js_number(Some("-0x10")).is_nan());
        assert_eq!(js_number(Some("Infinity")), f64::INFINITY);
    }

    /// The two words Rust's parser takes and JavaScript's does not. Without
    /// this, `?page=inf` would send GitHub an infinite page number.
    #[test]
    fn refuses_rusts_own_spellings() {
        for spelling in ["inf", "infinity", "NaN", "nan", "-inf"] {
            assert!(js_number(Some(spelling)).is_nan(), "{spelling}");
        }
    }

    #[test]
    fn zero_and_not_a_number_both_fall_back() {
        assert_eq!(js_number_or(Some("0"), 1.0), 1.0);
        assert_eq!(js_number_or(Some("abc"), 1.0), 1.0);
        assert_eq!(js_number_or(Some("-0"), 1.0), 1.0);
        assert_eq!(js_number_or(Some("5"), 1.0), 5.0);
    }

    #[test]
    fn prints_what_a_template_literal_prints() {
        assert_eq!(js_number_string(1.0), "1");
        assert_eq!(js_number_string(2.7), "2.7");
        assert_eq!(js_number_string(-3.0), "-3");
        assert_eq!(js_number_string(100.0), "100");
        assert_eq!(js_number_string(f64::INFINITY), "Infinity");
    }
}
