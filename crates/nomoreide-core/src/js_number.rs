//! `Number(text)` and `JSON.stringify(number)`, which are two different things.
//!
//! Wherever a route parses a number out of text a remote machine printed and
//! then hands it straight back as JSON, both halves of JavaScript's number
//! behaviour are part of the answer:
//!
//! - **Reading.** `Number("")` is zero, not a failure. `Number("  12  ")` is
//!   twelve. Anything else unreadable is `NaN`, and the callers test for that
//!   with `Number.isFinite` rather than catching.
//! - **Writing.** Every JavaScript number is a double, but `JSON.stringify`
//!   spells a whole one without a fractional part. `serde_json` writes an `f64`
//!   of `40.0` as `40.0`, where the reference writes `40`.
//!
//! The writing half is why these are values rather than strings: a percentage
//! that lands exactly on a whole number has to serialise as `40`, and the only
//! place to decide that is where the `Value` is built.

use serde_json::Value;

/// Beyond this a double no longer represents every integer, so treating one as
/// an integer would change it. `JSON.stringify` keeps writing whole numbers
/// without a point well past here, but nothing this module reads gets close and
/// falling back to the float spelling is the safe direction to be wrong in.
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Number(text)`.
///
/// Not a full port of the abstract `ToNumber`: hexadecimal literals, `Infinity`
/// and the numeric separators JavaScript accepts are all missing, because every
/// caller here is reading a decimal a POSIX tool printed. What matters is that
/// blank is zero and unreadable is `NaN`, since those are the two the callers
/// branch on.
pub fn parse(raw: &str) -> f64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    // Rust reads these; `Number` does not, and a host that printed one would
    // otherwise be reported as a value rather than as unreadable.
    if trimmed.eq_ignore_ascii_case("nan")
        || trimmed.eq_ignore_ascii_case("inf")
        || trimmed.eq_ignore_ascii_case("infinity")
        || trimmed.eq_ignore_ascii_case("+infinity")
        || trimmed.eq_ignore_ascii_case("-infinity")
    {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// One number, spelled the way `JSON.stringify` spells it.
///
/// A non-finite value has no JSON spelling; JavaScript writes `null` for it,
/// and so does this. No caller should reach that — they check first — but
/// silently emitting `0` would be worse than emitting what the reference emits.
pub fn value(number: f64) -> Value {
    if !number.is_finite() {
        return Value::Null;
    }
    if number.fract() == 0.0 && number.abs() <= SAFE_INTEGER {
        return Value::from(number as i64);
    }
    Value::from(number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_string_is_zero_and_a_word_is_not_a_number() {
        assert_eq!(parse(""), 0.0);
        assert_eq!(parse("   "), 0.0);
        assert!(parse("not-a-size").is_nan());
        assert!(parse("inf").is_nan());
        assert_eq!(parse("  12  "), 12.0);
        assert_eq!(parse("1e3"), 1000.0);
        assert_eq!(parse("123456.78"), 123_456.78);
    }

    #[test]
    fn a_whole_number_loses_its_fractional_part() {
        assert_eq!(value(40.0).to_string(), "40");
        assert_eq!(value(0.0).to_string(), "0");
        assert_eq!(value(-0.0).to_string(), "0");
        assert_eq!(value(102_400_000_000.0).to_string(), "102400000000");
    }

    #[test]
    fn a_fractional_number_keeps_it() {
        assert_eq!(value(12.5).to_string(), "12.5");
        assert_eq!(value(12.055_664_062_5).to_string(), "12.0556640625");
    }

    #[test]
    fn a_value_with_no_json_spelling_is_null() {
        assert_eq!(value(f64::NAN), Value::Null);
        assert_eq!(value(f64::INFINITY), Value::Null);
    }
}
