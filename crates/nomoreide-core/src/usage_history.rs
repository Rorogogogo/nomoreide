//! Token and cost totals, kept over time.
//!
//! The Rust half of `src/core/usage-history.ts`. An append-only JSONL file at
//! `~/.nomoreide/usage-history.jsonl`: a sampler hands {@link UsageHistory::record}
//! the latest reading, and a row lands only when a source's totals have
//! actually moved, so an idle agent does not grow the file every tick.
//!
//! **Nothing validates a row on the way back in.** The reference parses each
//! line and keeps whatever it got, so a file that has been hand-edited, half
//! written, or produced by an older build reaches the summary as-is — and the
//! arithmetic then does whatever JavaScript's arithmetic does with it, which is
//! usually `NaN` and therefore `null` on the wire. That is reproduced rather
//! than cleaned up: a port that dropped malformed rows would report a smaller
//! bill than the reference, and the whole point of the file is the bill.
//!
//! Two narrowings, both confined to rows no writer here produces:
//!
//! - A field holding a **string** is treated as unreadable rather than
//!   concatenated. JavaScript's `+` would make `0 + "1.5"` the string `"01.5"`
//!   and put that in the JSON; reproducing that faithfully would mean carrying
//!   JavaScript's addition into every total for a case only a corrupted file
//!   can reach.
//! - A claude row whose `at` is **not a string** makes the reference throw,
//!   because it slices `at` to get a date. Here the row is left out of the
//!   day buckets instead.

use crate::js_number;
use crate::locale;
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::io::AsyncWriteExt;

#[derive(Default)]
struct RecordState {
    seeded: bool,
    last_key: HashMap<String, String>,
}

pub struct UsageHistory {
    file_path: PathBuf,
    state: Mutex<RecordState>,
}

impl UsageHistory {
    pub fn new(file_path: PathBuf) -> Self {
        Self {
            file_path,
            state: Mutex::new(RecordState::default()),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    /// Every row, oldest first, optionally from an instant onwards.
    ///
    /// `since` is compared against `at` as a **string**, not as a date, which is
    /// what makes a bare `2026-08` work as a prefix and what makes a row whose
    /// `at` is missing drop out of a filtered answer.
    ///
    /// An **empty** `since` is no filter at all. The reference tests it for
    /// truthiness rather than for presence, and the empty string is falsy — so
    /// `?since=` answers with everything, including the rows a real filter
    /// would drop for having no `at` to compare.
    pub async fn list(&self, since: Option<&str>) -> Vec<Value> {
        let entries = self.load_entries().await;
        let Some(since) = since.filter(|value| !value.is_empty()) else {
            return entries;
        };
        entries
            .into_iter()
            .filter(|entry| match entry.get("at").and_then(Value::as_str) {
                Some(at) => locale::code_unit_cmp(at, since) != Ordering::Less,
                None => false,
            })
            .collect()
    }

    /// What the rows add up to.
    ///
    /// Claude reports a real per-session cost that grows within a run and resets
    /// on the next one, so each session contributes its dearest row once and
    /// `runs` counts sessions rather than samples. Codex reports a lifetime
    /// total instead, so its number is the largest seen rather than a sum.
    pub async fn summary(&self, since: Option<&str>) -> Value {
        let entries = self.list(since).await;

        let mut sessions: Vec<(String, Value)> = Vec::new();
        for entry in &entries {
            if entry.get("source").and_then(Value::as_str) != Some("claude") {
                continue;
            }
            let key = session_key(entry);
            match sessions.iter_mut().find(|(existing, _)| *existing == key) {
                // `>=`, so the later of two equally dear rows wins.
                Some((_, previous)) if number_ge(entry.get("costUSD"), previous.get("costUSD")) => {
                    *previous = entry.clone();
                }
                Some(_) => {}
                None => sessions.push((key, entry.clone())),
            }
        }

        let mut total_cost = 0.0;
        let mut total_input = 0.0;
        let mut total_output = 0.0;
        let mut total_tokens = 0.0;
        let mut by_day: Vec<(String, f64, u64, f64)> = Vec::new();
        for (_, session) in &sessions {
            total_cost = add(total_cost, session.get("costUSD"));
            total_input = add(total_input, session.get("inputTokens"));
            total_output = add(total_output, session.get("outputTokens"));
            total_tokens = add(total_tokens, session.get("totalTokens"));
            let Some(date) = session.get("at").and_then(Value::as_str).map(date_of) else {
                continue;
            };
            let bucket = match by_day.iter_mut().find(|(existing, ..)| *existing == date) {
                Some(bucket) => bucket,
                None => {
                    by_day.push((date, 0.0, 0, 0.0));
                    by_day.last_mut().expect("just pushed")
                }
            };
            bucket.1 = add(bucket.1, session.get("costUSD"));
            bucket.2 += 1;
            bucket.3 = add(bucket.3, session.get("totalTokens"));
        }
        by_day.sort_by(|left, right| locale::compare(&left.0, &right.0));

        let (first_at, last_at) = extremes(&entries);

        let mut summary = Map::new();
        summary.insert("runs".into(), Value::from(sessions.len()));
        summary.insert("totalCostUSD".into(), js_number::value(total_cost));
        summary.insert("totalInputTokens".into(), js_number::value(total_input));
        summary.insert("totalOutputTokens".into(), js_number::value(total_output));
        summary.insert("totalTokens".into(), js_number::value(total_tokens));
        if let Some(first) = first_at {
            summary.insert("firstAt".into(), first);
        }
        if let Some(last) = last_at {
            summary.insert("lastAt".into(), last);
        }
        summary.insert(
            "byDay".into(),
            Value::Array(
                by_day
                    .into_iter()
                    .map(|(date, cost, runs, tokens)| {
                        let mut bucket = Map::new();
                        bucket.insert("date".into(), Value::String(date));
                        bucket.insert("costUSD".into(), js_number::value(cost));
                        bucket.insert("runs".into(), Value::from(runs));
                        bucket.insert("totalTokens".into(), js_number::value(tokens));
                        Value::Object(bucket)
                    })
                    .collect(),
            ),
        );
        summary.insert("codexTotalTokens".into(), codex_total(&entries));
        Value::Object(summary)
    }

    /// Append a row per source whose totals have moved. Returns what was written.
    pub async fn record(&self, usage: &Value) -> Vec<Value> {
        if !self.is_seeded() {
            let seeds: Vec<(String, String)> = self
                .load_entries()
                .await
                .iter()
                .filter_map(|entry| {
                    let source = entry.get("source").and_then(Value::as_str)?;
                    Some((source.to_string(), entry_key(entry)))
                })
                .collect();
            if let Ok(mut state) = self.state.lock() {
                state.seeded = true;
                for (source, key) in seeds {
                    state.last_key.insert(source, key);
                }
            }
        }

        let at = now_iso();
        let mut candidates = Vec::new();
        if let Some(claude) = usage.get("claude").filter(|value| has_claude_data(value)) {
            candidates.push(claude_entry(&at, claude));
        }
        if let Some(codex) = usage
            .get("codex")
            .filter(|value| number_of(value.get("totalTokens")) > 0.0)
        {
            candidates.push(codex_entry(&at, codex));
        }

        let mut appended = Vec::new();
        if let Ok(mut state) = self.state.lock() {
            for entry in candidates {
                let source = entry
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let key = entry_key(&entry);
                if state.last_key.get(&source) == Some(&key) {
                    continue;
                }
                state.last_key.insert(source, key);
                appended.push(entry);
            }
        }
        if appended.is_empty() {
            return appended;
        }

        let mut body = String::new();
        for entry in &appended {
            body.push_str(&entry.to_string());
            body.push('\n');
        }
        // A file the user has made read-only, or a home that has gone away, is
        // not worth failing a sample over: the next tick tries again.
        if let Some(parent) = self.file_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(mut file) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
            .await
        {
            let _ = file.write_all(body.as_bytes()).await;
        }
        appended
    }

    fn is_seeded(&self) -> bool {
        self.state.lock().map(|state| state.seeded).unwrap_or(true)
    }

    async fn load_entries(&self) -> Vec<Value> {
        let Ok(raw) = tokio::fs::read_to_string(&self.file_path).await else {
            return Vec::new();
        };
        raw.split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect()
    }
}

// --- the arithmetic ----------------------------------------------------------

/// `total += entry[key]`, with JavaScript's answer for the values that are not
/// numbers. An absent field poisons the total to `NaN`, which is `null` on the
/// wire — see the module note for the one narrowing.
fn add(total: f64, value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Number(number)) => total + number.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => total,
        Some(Value::Bool(flag)) => total + if *flag { 1.0 } else { 0.0 },
        Some(_) => f64::NAN,
    }
}

/// `Number(value)`, for the coercion `Math.max` and a `> 0` test apply.
fn number_of(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::String(text)) => js_number::parse(text),
        Some(_) => f64::NAN,
    }
}

/// `left >= right`. Comparing anything unreadable is false, which is why a row
/// with no cost never displaces one that has a cost.
fn number_ge(left: Option<&Value>, right: Option<&Value>) -> bool {
    let (left, right) = (number_of(left), number_of(right));
    left.is_finite() && right.is_finite() && left >= right
}

/// `entry.sessionId ?? entry.at`, as something that can key a map.
///
/// The JSON spelling rather than the bare text, so the string `"5"` and the
/// number `5` stay two different sessions the way two `Map` keys would.
fn session_key(entry: &Value) -> String {
    match entry.get("sessionId") {
        Some(Value::Null) | None => entry.get("at").unwrap_or(&Value::Null).to_string(),
        Some(value) => value.to_string(),
    }
}

/// `at.slice(0, 10)` — the first ten UTF-16 code units, which is the date.
fn date_of(at: &str) -> String {
    String::from_utf16_lossy(&at.encode_utf16().take(10).collect::<Vec<u16>>())
}

/// `firstAt` and `lastAt`: the ends of every `at` sorted the way `Array#sort`
/// sorts with no comparator — as text, with the missing ones last. A single row
/// with no `at` therefore takes `lastAt` off the answer entirely.
fn extremes(entries: &[Value]) -> (Option<Value>, Option<Value>) {
    let mut present: Vec<&Value> = Vec::new();
    let mut missing = 0usize;
    for entry in entries {
        match entry.get("at") {
            Some(at) => present.push(at),
            None => missing += 1,
        }
    }
    present.sort_by(|left, right| locale::code_unit_cmp(&js_string(left), &js_string(right)));
    let first = present.first().map(|value| (*value).clone());
    let last = if missing > 0 {
        None
    } else {
        present.last().map(|value| (*value).clone())
    };
    (first, last)
}

/// `String(value)`, for the sort above.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// `Math.max` over every Codex row's total, or zero when there are none.
fn codex_total(entries: &[Value]) -> Value {
    let totals: Vec<f64> = entries
        .iter()
        .filter(|entry| entry.get("source").and_then(Value::as_str) == Some("codex"))
        .map(|entry| number_of(entry.get("totalTokens")))
        .collect();
    if totals.is_empty() {
        return Value::from(0);
    }
    let mut largest = f64::NEG_INFINITY;
    for total in totals {
        if total.is_nan() {
            return Value::Null;
        }
        if total > largest {
            largest = total;
        }
    }
    js_number::value(largest)
}

// --- writing -----------------------------------------------------------------

fn has_claude_data(claude: &Value) -> bool {
    ["costUSD", "inputTokens", "outputTokens"]
        .iter()
        .any(|key| number_of(claude.get(*key)) > 0.0)
}

fn claude_entry(at: &str, claude: &Value) -> Value {
    let mut entry = Map::new();
    entry.insert("at".into(), Value::String(at.to_string()));
    entry.insert("source".into(), Value::String("claude".into()));
    if let Some(session) = claude.get("sessionId").filter(|value| !value.is_null()) {
        entry.insert("sessionId".into(), session.clone());
    }
    let input = number_of(claude.get("inputTokens"));
    let output = number_of(claude.get("outputTokens"));
    entry.insert("inputTokens".into(), js_number::value(input));
    entry.insert("outputTokens".into(), js_number::value(output));
    entry.insert("totalTokens".into(), js_number::value(input + output));
    entry.insert(
        "costUSD".into(),
        js_number::value(number_of(claude.get("costUSD"))),
    );
    if let Some(Value::Array(models)) = claude.get("models") {
        entry.insert(
            "models".into(),
            Value::Array(
                models
                    .iter()
                    .map(|model| model.get("model").cloned().unwrap_or(Value::Null))
                    .collect(),
            ),
        );
    }
    Value::Object(entry)
}

fn codex_entry(at: &str, codex: &Value) -> Value {
    let mut entry = Map::new();
    entry.insert("at".into(), Value::String(at.to_string()));
    entry.insert("source".into(), Value::String("codex".into()));
    if let Some(timestamp) = codex.get("timestamp").filter(|value| !value.is_null()) {
        entry.insert("sessionId".into(), timestamp.clone());
    }
    for key in ["inputTokens", "outputTokens", "totalTokens"] {
        entry.insert(key.into(), js_number::value(number_of(codex.get(key))));
    }
    entry.insert("costUSD".into(), Value::from(0));
    Value::Object(entry)
}

/// The dedup key: what would have to change for a row to be worth writing.
fn entry_key(entry: &Value) -> String {
    let session = match entry.get("sessionId") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => js_string(other),
    };
    if entry.get("source").and_then(Value::as_str) == Some("codex") {
        return format!("codex:{session}:{}", js_string(entry.get("totalTokens").unwrap_or(&Value::Null)));
    }
    format!(
        "claude:{session}:{}:{}:{}",
        js_string(entry.get("costUSD").unwrap_or(&Value::Null)),
        js_string(entry.get("inputTokens").unwrap_or(&Value::Null)),
        js_string(entry.get("outputTokens").unwrap_or(&Value::Null)),
    )
}

/// `new Date().toISOString()` — milliseconds and a `Z`, which is what the
/// `since` filter's string comparison is built around.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
