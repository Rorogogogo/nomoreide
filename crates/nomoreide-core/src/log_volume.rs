//! How much a service said, and how badly, over the range its graph covers.
//!
//! The Rust half of `src/core/log-volume.ts`. The CPU and memory panes give the
//! log tail an axis; this gives that axis the series it was missing. A CPU spike
//! says *when* something happened but not whether the service noticed; a burst
//! of errors in the same minute says it did.
//!
//! **Bucketed here rather than in the browser, because the browser cannot.** The
//! dashboard payload carries forty lines per service, which is a few seconds of
//! a service mid-burst — far too short an axis to bucket. The ring buffer this
//! reads holds five hundred and lives in the daemon; sending all of them per
//! poll so a client could count them would be the same payload mistake at ten
//! times the size.

use serde_json::{json, Value};

/// Sixty across the window, whatever the window is.
///
/// A count, not a duration, because the range is whatever the metric buffer
/// happens to hold: half an hour for a service up all morning, two minutes for
/// one that just booted. A fixed duration would give the young service four
/// bars and the old one a thousand; a fixed count keeps the strip the same
/// shape and lets a bar mean "a sixtieth of what you are looking at" in both.
const BUCKET_COUNT: usize = 60;

/// Count each severity into evenly spaced buckets over the samples' range.
///
/// The range comes from the samples rather than from the lines, and that is the
/// point: the strip is only honest if it is the *same* axis as the panes above
/// it. Lines outside it are dropped rather than clamped — a service that
/// emitted four hundred lines at boot and has been quiet since is quiet in the
/// window being shown, and piling that history onto the first bucket would
/// invent a spike at a moment nothing happened.
pub fn bucket_log_volume(lines: &[(String, String)], sample_times: &[f64]) -> Vec<Value> {
    if sample_times.len() < 2 {
        return Vec::new();
    }
    let first = sample_times[0];
    let last = sample_times[sample_times.len() - 1];
    let span = last - first;
    if span <= 0.0 {
        return Vec::new();
    }

    let width = span / BUCKET_COUNT as f64;
    let mut counts = vec![[0_u64; 3]; BUCKET_COUNT];
    for (timestamp, text) in lines {
        let at = match chrono::DateTime::parse_from_rfc3339(timestamp) {
            Ok(parsed) => parsed.timestamp_millis() as f64,
            Err(_) => continue,
        };
        if at < first || at > last {
            continue;
        }
        // The final bucket is closed at both ends, so the newest line — which
        // is exactly `last` whenever a sample and a line share a millisecond —
        // lands in the strip rather than one index past it.
        let index = (((at - first) / width).floor() as usize).min(BUCKET_COUNT - 1);
        counts[index][band_of(text)] += 1;
    }

    counts
        .into_iter()
        .enumerate()
        .map(|(index, [info, warning, error])| {
            json!({
                "t": crate::js_number::value(first + index as f64 * width),
                "info": info,
                "warning": warning,
                "error": error,
            })
        })
        .collect()
}

/// Which band a line counts toward — decided by what it *says*, never by which
/// pipe it came down.
///
/// Reading the stream first looks right and is not: of one real dev server's
/// ten stderr lines, none were errors — they were a "found 0 errors" summary, a
/// freshness notice, and six lines beginning with the literal word `warn`. A
/// rule that paints "found 0 errors" red is not strict, it is broken, and it
/// costs the amber band the exact case amber is for. Nothing is lost: a service
/// that dies on stderr dies saying `panic`, `fatal` or `error`, and the
/// classifier is looking for all of them.
fn band_of(text: &str) -> usize {
    match crate::log_store::classify_severity(text).as_deref() {
        Some("error") => 2,
        Some("warning") => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(timestamp: &str, text: &str) -> (String, String) {
        (timestamp.to_string(), text.to_string())
    }

    #[test]
    fn fewer_than_two_samples_have_no_range_to_bucket_over() {
        assert!(bucket_log_volume(&[], &[]).is_empty());
        assert!(bucket_log_volume(&[], &[1.0]).is_empty());
        // Two samples at the same instant span nothing.
        assert!(bucket_log_volume(&[], &[5.0, 5.0]).is_empty());
    }

    #[test]
    fn a_line_outside_the_window_is_dropped_rather_than_clamped() {
        let samples = [1_000.0, 61_000.0];
        let lines = [
            line("1970-01-01T00:00:00.500Z", "before the window"),
            line("1970-01-01T00:01:30.000Z", "after the window"),
            line("not a timestamp at all", "unreadable"),
        ];
        let buckets = bucket_log_volume(&lines, &samples);
        assert_eq!(buckets.len(), 60);
        let total: u64 = buckets
            .iter()
            .map(|bucket| {
                ["info", "warning", "error"]
                    .iter()
                    .map(|key| bucket[*key].as_u64().unwrap_or(0))
                    .sum::<u64>()
            })
            .sum();
        assert_eq!(total, 0);
    }

    #[test]
    fn the_last_bucket_is_closed_at_both_ends() {
        let samples = [0.0, 60_000.0];
        let lines = [line("1970-01-01T00:01:00.000Z", "exactly at the end")];
        let buckets = bucket_log_volume(&lines, &samples);
        assert_eq!(buckets[59]["info"].as_u64(), Some(1));
    }
}
