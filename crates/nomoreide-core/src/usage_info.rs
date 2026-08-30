//! What the two agents say they have spent.
//!
//! The Rust half of `src/web/usage-info.ts`. Both readings come from files the
//! agents write for themselves — `~/.claude.json`, `~/.claude/state/usage`, and
//! the Codex session rollouts — so nothing here asks an agent anything, and a
//! machine where neither has ever run simply reports nothing.
//!
//! **Every number goes through `to_number`, which never fails.** The reference
//! reads these values out of files it does not own and coerces each one the way
//! `Number()` would, falling back to zero rather than to an error. A field that
//! is missing, null, a boolean, an object, or a string of prose is zero; a
//! string that reads as a number is that number. Nothing here rejects a file
//! for being malformed, because the alternative is a usage panel that goes
//! blank when an agent writes a field this code did not expect.

use crate::js_number;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// The tail of a rollout that is read. Codex appends, so the newest events are
/// at the end; a session that has run for days can be far larger than this.
const TAIL_BYTES: u64 = 2_000_000;

/// How far below `sessions/` the walk goes. Codex nests by date, so the real
/// tree is three or four deep and this is the reference's own ceiling.
const MAX_DEPTH: usize = 4;

/// How many rollouts are opened, newest first.
const MAX_FILES: usize = 20;

pub fn codex_home() -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => crate::home::home_directory().join(".codex"),
    }
}

/// `{}`, `{ claude }`, `{ codex }`, or both — a source with no reading is an
/// absent key rather than a null, which is what the dashboard tests for.
pub async fn build_usage_info(cwd: &str) -> Value {
    let home = crate::home::home_directory();
    let codex_root = codex_home();
    let (claude, codex) =
        tokio::join!(read_claude_usage(&home, cwd), read_codex_usage(&codex_root));
    let mut result = Map::new();
    if let Some(claude) = claude {
        result.insert("claude".into(), claude);
    }
    if let Some(codex) = codex {
        result.insert("codex".into(), codex);
    }
    Value::Object(result)
}

// --- JavaScript's idea of these values ---------------------------------------

/// A property read that works on anything, because the reference's does: a
/// field of a non-object is `undefined`, not an error.
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// `typeof value === "object" && value !== null` — which arrays satisfy.
///
/// It matters: `rate_limits: { primary: [] }` is an object to the reference, so
/// it produces a window of zeros rather than no window at all.
fn is_object_like(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

/// `toNumber`: a finite number, or a string that reads as one, or zero.
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0),
        Value::String(text) => {
            let parsed = js_number::parse(text);
            if parsed.is_finite() {
                parsed
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

fn number(value: &Value) -> Value {
    js_number::value(to_number(value))
}

// --- Claude ------------------------------------------------------------------

/// The two rate-limit windows, out of a tab-separated file Claude Code writes.
///
/// Four fields: block percent, block reset, weekly percent, weekly reset. A
/// window is reported only when its reset is a positive instant — a zero reset
/// is how the file spells "no window", and reporting it would draw a bar that
/// resets at the epoch.
async fn read_claude_state_usage(home: &Path) -> (Option<Value>, Option<Value>) {
    let path = home.join(".claude").join("state").join("usage");
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return (None, None);
    };
    let parts: Vec<&str> = raw.trim().split('\t').collect();
    let at = |index: usize| js_number::parse(parts.get(index).copied().unwrap_or_default());
    let window = |percent: f64, reset: f64| {
        // `toNumber` has already turned anything unreadable into zero, so the
        // reference's finiteness checks can only ever pass; the reset is the
        // one that decides.
        (percent.is_finite() && reset.is_finite() && reset > 0.0).then(|| {
            let mut window = Map::new();
            window.insert("usedPercent".into(), js_number::value(percent));
            window.insert("resetsAtUnix".into(), js_number::value(reset));
            Value::Object(window)
        })
    };
    // A blank field reads as zero, which is what `Number("")` does; an
    // unreadable one reads as NaN, which fails the finiteness test the way
    // `toNumber`'s zero fails the positivity test.
    let normalise = |value: f64| if value.is_finite() { value } else { 0.0 };
    (
        window(normalise(at(0)), normalise(at(1))),
        window(normalise(at(2)), normalise(at(3))),
    )
}

async fn read_claude_usage(home: &Path, cwd: &str) -> Option<Value> {
    let raw = tokio::fs::read_to_string(home.join(".claude.json"))
        .await
        .ok()?;
    let document: Value = serde_json::from_str(&raw).ok()?;
    let project = field(field(&document, "projects"), cwd).clone();
    let (five_hour, weekly) = read_claude_state_usage(home).await;

    let mut usage = Map::new();
    usage.insert("cwd".into(), Value::String(cwd.to_string()));

    // No entry for this directory, and no windows either: nothing to report.
    // With windows but no entry there still is — they are reported against a
    // zeroed project rather than dropped, because a rate limit applies to the
    // machine rather than to one directory.
    if project.is_null() && five_hour.is_none() && weekly.is_none() {
        return None;
    }

    if let Some(session) = field(&project, "lastSessionId").as_str() {
        usage.insert("sessionId".into(), Value::String(session.to_string()));
    }
    for (key, source) in [
        ("costUSD", "lastCost"),
        ("durationMs", "lastDuration"),
        ("apiDurationMs", "lastAPIDuration"),
        ("linesAdded", "lastLinesAdded"),
        ("linesRemoved", "lastLinesRemoved"),
        ("inputTokens", "lastTotalInputTokens"),
        ("outputTokens", "lastTotalOutputTokens"),
        (
            "cacheCreationInputTokens",
            "lastTotalCacheCreationInputTokens",
        ),
        ("cacheReadInputTokens", "lastTotalCacheReadInputTokens"),
        ("webSearchRequests", "lastTotalWebSearchRequests"),
    ] {
        usage.insert(key.into(), number(field(&project, source)));
    }
    usage.insert("models".into(), Value::Array(model_usage(&project)));
    if let Some(window) = five_hour {
        usage.insert("fiveHour".into(), window);
    }
    if let Some(window) = weekly {
        usage.insert("weekly".into(), window);
    }
    Some(Value::Object(usage))
}

/// Per-model totals, dearest first.
///
/// The sort is stable, so two models that cost the same keep the order the file
/// listed them in. An array here is still an object to the reference, and its
/// indices become the model names.
fn model_usage(project: &Value) -> Vec<Value> {
    let raw = field(project, "lastModelUsage");
    if !is_object_like(raw) {
        return Vec::new();
    }
    let entries: Vec<(String, &Value)> = match raw {
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| (key.clone(), value))
            .collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        _ => Vec::new(),
    };
    let mut models: Vec<(f64, Value)> = entries
        .into_iter()
        .map(|(model, entry)| {
            let mut row = Map::new();
            row.insert("model".into(), Value::String(model));
            for key in [
                "inputTokens",
                "outputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
                "webSearchRequests",
                "costUSD",
            ] {
                row.insert(key.into(), number(field(entry, key)));
            }
            (to_number(field(entry, "costUSD")), Value::Object(row))
        })
        .collect();
    models.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    models.into_iter().map(|(_, row)| row).collect()
}

// --- Codex -------------------------------------------------------------------

/// The newest rollout that says anything about tokens.
///
/// Two orderings are at work and they are not the same one. Files are ranked by
/// **mtime**, and the walk stops at the first file that yields a reading — so a
/// rollout touched more recently wins even if an older one holds an event with
/// a later `timestamp`. Within a file, lines are ranked by that `timestamp`.
async fn read_codex_usage(codex_home: &Path) -> Option<Value> {
    let mut files = Vec::new();
    collect_rollouts(&codex_home.join("sessions"), &mut files, 0).await;
    if files.is_empty() {
        return None;
    }
    files.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for (_, path) in files.into_iter().take(MAX_FILES) {
        let mut best: Option<(String, Value)> = None;
        for line in tail_lines(&path).await {
            // The reference tests the raw line before parsing it, so a line that
            // does not mention token counts costs nothing.
            if !line.contains("token_count") {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(usage) = token_count_event(&event) else {
                continue;
            };
            let timestamp = field(&event, "timestamp")
                .as_str()
                .unwrap_or_default()
                .to_string();
            if best.as_ref().map_or(true, |(previous, _)| {
                crate::locale::code_unit_cmp(&timestamp, previous) == std::cmp::Ordering::Greater
            }) {
                best = Some((timestamp, usage));
            }
        }
        if let Some((_, usage)) = best {
            return Some(usage);
        }
    }
    None
}

/// One `token_count` event, or nothing if it carries no numbers at all.
fn token_count_event(event: &Value) -> Option<Value> {
    let payload = field(event, "payload");
    if field(payload, "type").as_str() != Some("token_count") {
        return None;
    }
    let info = field(payload, "info");
    // Event level first: a rollout that carries limits in both places is
    // reporting the outer one.
    let rate_limits = match field(event, "rate_limits") {
        Value::Null => field(payload, "rate_limits"),
        outer => outer,
    };
    let primary = read_window(field(rate_limits, "primary"));
    let secondary = read_window(field(rate_limits, "secondary"));
    let total = token_usage(field(info, "total_token_usage"));
    let last = token_usage(field(info, "last_token_usage"));
    if primary.is_none() && secondary.is_none() && total.is_none() && last.is_none() {
        return None;
    }

    let timestamp = field(event, "timestamp").as_str().unwrap_or_default();
    let mut usage = Map::new();
    if !timestamp.is_empty() {
        usage.insert("timestamp".into(), Value::String(timestamp.to_string()));
    }
    let totals = total.unwrap_or_default();
    let lasts = last.unwrap_or_default();
    for (key, value) in [
        ("inputTokens", totals.input),
        ("cachedInputTokens", totals.cached_input),
        ("outputTokens", totals.output),
        ("reasoningOutputTokens", totals.reasoning_output),
        ("totalTokens", totals.total),
        ("lastInputTokens", lasts.input),
        ("lastCachedInputTokens", lasts.cached_input),
        ("lastOutputTokens", lasts.output),
        ("lastReasoningOutputTokens", lasts.reasoning_output),
        ("lastTotalTokens", lasts.total),
    ] {
        usage.insert(key.into(), js_number::value(value));
    }
    let context_window = to_number(field(info, "model_context_window"));
    if context_window.is_finite() && context_window > 0.0 {
        usage.insert("contextWindow".into(), js_number::value(context_window));
    }
    if let Some(primary) = primary {
        usage.insert("primary".into(), primary);
    }
    if let Some(secondary) = secondary {
        usage.insert("secondary".into(), secondary);
    }
    Some(Value::Object(usage))
}

#[derive(Default)]
struct TokenUsage {
    input: f64,
    cached_input: f64,
    output: f64,
    reasoning_output: f64,
    total: f64,
}

/// All-zero is the same as absent: Codex writes a zeroed block before the first
/// turn, and reporting it would claim a session had started spending.
fn token_usage(value: &Value) -> Option<TokenUsage> {
    if !is_object_like(value) {
        return None;
    }
    let usage = TokenUsage {
        input: to_number(field(value, "input_tokens")),
        cached_input: to_number(field(value, "cached_input_tokens")),
        output: to_number(field(value, "output_tokens")),
        reasoning_output: to_number(field(value, "reasoning_output_tokens")),
        total: to_number(field(value, "total_tokens")),
    };
    let empty = usage.input == 0.0
        && usage.cached_input == 0.0
        && usage.output == 0.0
        && usage.reasoning_output == 0.0
        && usage.total == 0.0;
    if empty {
        None
    } else {
        Some(usage)
    }
}

fn read_window(value: &Value) -> Option<Value> {
    if !is_object_like(value) {
        return None;
    }
    let mut window = Map::new();
    window.insert("usedPercent".into(), number(field(value, "used_percent")));
    window.insert("resetsAtUnix".into(), number(field(value, "resets_at")));
    let minutes = to_number(field(value, "window_minutes"));
    if minutes.is_finite() && minutes > 0.0 {
        window.insert("windowMinutes".into(), js_number::value(minutes));
    }
    Some(Value::Object(window))
}

/// Every `.jsonl` under `sessions/`, with its mtime in milliseconds.
///
/// Unreadable directories are skipped rather than reported: a sessions tree
/// with one bad permission should still yield the rollouts it can.
async fn collect_rollouts(dir: &Path, out: &mut Vec<(f64, PathBuf)>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let mut directories = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(kind) = entry.file_type().await else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            directories.push(path);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            if let Ok(metadata) = tokio::fs::metadata(&path).await {
                out.push((modified_ms(&metadata), path));
            }
        }
    }
    for directory in directories {
        Box::pin(collect_rollouts(&directory, out, depth + 1)).await;
    }
}

fn modified_ms(metadata: &std::fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// The last two megabytes, split into lines.
///
/// A cut that lands mid-character leaves replacement characters in the first
/// line, which is exactly what the reference's `Buffer.toString` does; that
/// line then fails to parse and is skipped, which is the point.
async fn tail_lines(path: &Path) -> Vec<String> {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return Vec::new();
    };
    let Ok(metadata) = file.metadata().await else {
        return Vec::new();
    };
    let size = metadata.len();
    let start = size.saturating_sub(TAIL_BYTES);
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return Vec::new();
    }
    let mut buffer = Vec::with_capacity((size - start) as usize);
    if file.read_to_end(&mut buffer).await.is_err() {
        return Vec::new();
    }
    String::from_utf8_lossy(&buffer)
        .split('\n')
        .map(str::to_string)
        .collect()
}
