//! The read-only remote file protocol, shared by SSH and `docker exec`.
//!
//! The Rust half of `src/core/read-only-files.ts`. Two shell scripts run on the
//! far end and emit NUL-delimited fields, so a filename containing spaces,
//! tabs, quotes or newlines stays data rather than becoming syntax. Nothing
//! here parses human-oriented `ls` output, and nothing here writes.
//!
//! **The scripts are compared, not just executed.** A transport failure is
//! reported by quoting the whole command that failed, so the script text is
//! part of the answer a client sees. They are reproduced here byte for byte,
//! including the absence of a trailing newline — a stray one would change every
//! error message on this surface.

use crate::js_number;
use crate::locale;
use serde_json::{json, Map, Value};
use std::cmp::Ordering;

/// How much of a file comes back. The remote sends one byte more than this so
/// the caller can tell "exactly full" from "there is more".
pub const FILE_PREVIEW_BYTES: usize = 256 * 1024;

/// Listing and previewing get their own budget, longer than a probe's: a
/// directory on a slow link is still worth waiting for.
pub const FILE_READ_TIMEOUT_MS: u64 = 10_000;

/// `find` emits one NUL-terminated field per column and a bare NUL between
/// records. `%T@` is seconds with a fractional part, which is why the caller
/// multiplies rather than parses an integer.
pub const READ_DIRECTORY_SCRIPT: &str = concat!(
    "target=$1\n",
    "cd \"$target\" || exit 1\n",
    "printf 'NMI_PATH\\0%s\\0' \"$PWD\"\n",
    "find . -mindepth 1 -maxdepth 1 -printf 'NMI_ENTRY\\0%f\\0%y\\0%s\\0%T@\\0\\0'"
);

/// The header carries the file's **full** size; the body carries at most a
/// preview of it. They are deliberately two numbers — a client showing "12 KB"
/// beside a truncated preview needs the size that was not sent.
pub const READ_FILE_SCRIPT: &str = concat!(
    "target=$1\n",
    "test -f \"$target\" || { printf '%s\\n' 'Path is not a regular file.' >&2; exit 1; }\n",
    "size=$(wc -c < \"$target\") || exit 1\n",
    "printf 'NMI_FILE\\0%s\\0' \"$size\"\n",
    // 256 KiB + 1: one byte past the preview, so "full" and "truncated" differ.
    "head -c 262145 -- \"$target\""
);

/// What a caller may ask for.
///
/// `.` is the one relative path allowed, and only for a directory — it is how
/// the browser opens the login directory without knowing what it is called. A
/// file has to be named absolutely, because there is no session to be relative
/// to.
pub fn assert_read_only_path(path: &str, require_absolute: bool) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') || (require_absolute && !path.starts_with('/')) {
        return Err(if require_absolute {
            "File path must be absolute.".to_string()
        } else {
            "File path is invalid.".to_string()
        });
    }
    if path != "." && !path.starts_with('/') {
        return Err("File path must be absolute.".to_string());
    }
    Ok(())
}

/// `{ path, entries }`, ready to be spread into a listing.
///
/// Decoded lossily on purpose: the far end's filenames are whatever bytes that
/// filesystem holds, and a name that is not UTF-8 is still a name the listing
/// has to show. `Buffer.toString("utf8")` substitutes the same replacement
/// character.
pub fn parse_read_only_directory(output: &[u8], include_hidden: bool) -> Result<Value, String> {
    let text = String::from_utf8_lossy(output);
    let fields: Vec<&str> = text.split('\0').collect();
    let unexpected = || "Directory returned an unexpected response.".to_string();
    if fields.first() != Some(&"NMI_PATH") {
        return Err(unexpected());
    }
    let path = *fields.get(1).ok_or_else(unexpected)?;
    if !path.starts_with('/') {
        return Err(unexpected());
    }

    let malformed = || "Directory entry is malformed.".to_string();
    let mut entries: Vec<Entry> = Vec::new();
    let mut index = 2;
    while index < fields.len() {
        // The record separator leaves a trailing empty field; that is the end
        // of the listing rather than a record that failed to parse.
        if fields[index].is_empty() {
            break;
        }
        if fields[index] != "NMI_ENTRY" {
            return Err(malformed());
        }
        let name = fields.get(index + 1).copied().unwrap_or_default();
        let raw_type = fields.get(index + 2).copied().unwrap_or_default();
        let size = js_number::parse(fields.get(index + 3).copied().unwrap_or_default());
        let modified_seconds = js_number::parse(fields.get(index + 4).copied().unwrap_or_default());
        if name.is_empty() || name.contains('/') || !size.is_finite() {
            return Err(malformed());
        }
        index += 6;
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        entries.push(Entry {
            name: name.to_string(),
            path: if path == "/" {
                format!("/{name}")
            } else {
                format!("{path}/{name}")
            },
            kind: file_type(raw_type),
            size,
            modified_at: if modified_seconds.is_finite() {
                // `Math.round`, which breaks a tie upward rather than to even.
                Some((modified_seconds * 1000.0 + 0.5).floor())
            } else {
                None
            },
        });
    }

    // Directories first; everything else — files, symlinks, sockets — sorts
    // together by name. The comparator only knows about `directory`, so a
    // symlink lands among the files rather than after them.
    entries.sort_by(|left, right| {
        if left.kind != right.kind {
            if left.kind == "directory" {
                return Ordering::Less;
            }
            if right.kind == "directory" {
                return Ordering::Greater;
            }
        }
        locale::compare(&left.name, &right.name)
    });

    Ok(json!({
        "path": path,
        "entries": entries.into_iter().map(Entry::into_value).collect::<Vec<_>>(),
    }))
}

struct Entry {
    name: String,
    path: String,
    kind: &'static str,
    size: f64,
    modified_at: Option<f64>,
}

impl Entry {
    fn into_value(self) -> Value {
        json!({
            "name": self.name,
            "path": self.path,
            "type": self.kind,
            "size": js_number::value(self.size),
            "modifiedAt": self.modified_at.map_or(Value::Null, js_number::value),
        })
    }
}

/// `{ path, content, size, binary, truncated }`, ready to be spread.
///
/// `size` is the remote's claim and `truncated` is a fact about what arrived,
/// so the two are computed from different things and a remote that lies about
/// one does not disturb the other.
pub fn parse_read_only_file(path: &str, output: &[u8]) -> Result<Value, String> {
    let first = output.iter().position(|byte| *byte == 0);
    let second = first.and_then(|start| {
        output[start + 1..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| start + 1 + offset)
    });
    let (Some(first), Some(second)) = (first, second) else {
        return Err("File returned an unexpected response.".to_string());
    };
    if &output[..first] != b"NMI_FILE" {
        return Err("File returned an unexpected response.".to_string());
    }
    let size = js_number::parse(&String::from_utf8_lossy(&output[first + 1..second]));
    if !size.is_finite() || size < 0.0 {
        return Err("File returned an invalid size.".to_string());
    }

    let bytes = &output[second + 1..];
    let preview = &bytes[..bytes.len().min(FILE_PREVIEW_BYTES)];
    // Only the first 8 KiB decides. A NUL further in is possible in a file that
    // is genuinely text up to here, and a preview is a preview.
    let binary = preview[..preview.len().min(8 * 1024)].contains(&0);

    let mut file = Map::new();
    file.insert("path".into(), Value::String(path.to_string()));
    file.insert(
        "content".into(),
        Value::String(if binary {
            String::new()
        } else {
            String::from_utf8_lossy(preview).into_owned()
        }),
    );
    file.insert("size".into(), js_number::value(size));
    file.insert("binary".into(), Value::Bool(binary));
    file.insert("truncated".into(), Value::Bool(size > preview.len() as f64));
    Ok(Value::Object(file))
}

/// `find`'s `%y`. Everything that is not a directory, a regular file or a
/// symlink is `other` — a socket and a block device are equally un-openable.
fn file_type(value: &str) -> &'static str {
    match value {
        "d" => "directory",
        "f" => "file",
        "l" => "symlink",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str, kind: &str, size: &str, mtime: &str) -> Vec<u8> {
        format!("NMI_ENTRY\0{name}\0{kind}\0{size}\0{mtime}\0\0").into_bytes()
    }

    fn listing(records: &[Vec<u8>]) -> Vec<u8> {
        let mut output = b"NMI_PATH\0/srv\0".to_vec();
        for entry in records {
            output.extend_from_slice(entry);
        }
        output
    }

    #[test]
    fn the_scripts_carry_no_trailing_newline() {
        // They are quoted verbatim into a failed command's error message, so a
        // stray newline here would change every error on this surface.
        assert!(!READ_DIRECTORY_SCRIPT.ends_with('\n'));
        assert!(!READ_FILE_SCRIPT.ends_with('\n'));
        assert!(READ_FILE_SCRIPT.contains("head -c 262145 -- \"$target\""));
    }

    #[test]
    fn a_dot_is_a_directory_but_never_a_file() {
        assert!(assert_read_only_path(".", false).is_ok());
        assert_eq!(
            assert_read_only_path(".", true).unwrap_err(),
            "File path must be absolute."
        );
        assert_eq!(
            assert_read_only_path("srv", false).unwrap_err(),
            "File path must be absolute."
        );
        assert_eq!(
            assert_read_only_path("/srv\0", false).unwrap_err(),
            "File path is invalid."
        );
    }

    #[test]
    fn directories_sort_first_and_the_rest_sort_by_name() {
        let output = listing(&[
            record("zeta", "f", "1", "1700000000"),
            record("Beta", "d", "4096", "1700000000"),
            record("alpha", "d", "4096", "1700000000"),
            record("link", "l", "1", "1700000000"),
            record("sock", "s", "0", "1700000000"),
            record("eclair", "f", "1", "1700000000"),
        ]);
        let parsed = parse_read_only_directory(&output, false).unwrap();
        let names: Vec<&str> = parsed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["alpha", "Beta", "eclair", "link", "sock", "zeta"],
            "a symlink and a socket sort among the files, not after them"
        );
        assert_eq!(parsed["entries"][3]["type"], "symlink");
        assert_eq!(parsed["entries"][4]["type"], "other");
    }

    #[test]
    fn a_hidden_entry_is_dropped_unless_it_was_asked_for() {
        let output = listing(&[
            record(".config", "d", "4096", "1700000000"),
            record("app", "d", "4096", "1700000000"),
        ]);
        let without = parse_read_only_directory(&output, false).unwrap();
        assert_eq!(without["entries"].as_array().unwrap().len(), 1);
        let with = parse_read_only_directory(&output, true).unwrap();
        assert_eq!(with["entries"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_fractional_timestamp_becomes_whole_milliseconds() {
        let output = listing(&[record("app", "d", "4096", "1700000002.25")]);
        let parsed = parse_read_only_directory(&output, false).unwrap();
        assert_eq!(parsed["entries"][0]["modifiedAt"], 1_700_000_002_250i64);
        assert_eq!(parsed["entries"][0]["size"], 4096);
    }

    #[test]
    fn a_header_that_is_not_the_marker_is_refused() {
        assert_eq!(
            parse_read_only_directory(b"NOT_A_HEADER\0/srv\0", false).unwrap_err(),
            "Directory returned an unexpected response."
        );
        // A path that is not absolute is the same refusal: the remote answered,
        // but not with a listing.
        assert!(parse_read_only_directory(b"NMI_PATH\0srv\0", false).is_err());
    }

    #[test]
    fn a_size_the_body_does_not_have_still_reports_the_size() {
        let parsed = parse_read_only_file("/var/lying", b"NMI_FILE\0999999\0only ten.").unwrap();
        assert_eq!(parsed["size"], 999_999);
        assert_eq!(parsed["content"], "only ten.");
        assert_eq!(parsed["truncated"], true);
        assert_eq!(parsed["binary"], false);
    }

    #[test]
    fn a_nul_in_the_first_pages_makes_it_binary_and_drops_the_content() {
        let mut output = b"NMI_FILE\08\0".to_vec();
        output.extend_from_slice(&[0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]);
        let parsed = parse_read_only_file("/bin/blob", &output).unwrap();
        assert_eq!(parsed["binary"], true);
        assert_eq!(parsed["content"], "");
        assert_eq!(parsed["size"], 8);
        assert_eq!(parsed["truncated"], false);
    }

    #[test]
    fn a_body_longer_than_the_preview_is_cut_but_the_size_is_not() {
        let body = vec![b'a'; FILE_PREVIEW_BYTES + 16];
        let mut output = format!("NMI_FILE\0{}\0", body.len()).into_bytes();
        output.extend_from_slice(&body);
        let parsed = parse_read_only_file("/var/huge", &output).unwrap();
        assert_eq!(parsed["size"], (FILE_PREVIEW_BYTES + 16) as i64);
        assert_eq!(
            parsed["content"].as_str().unwrap().len(),
            FILE_PREVIEW_BYTES
        );
        assert_eq!(parsed["truncated"], true);
    }

    #[test]
    fn a_size_that_is_not_a_number_is_its_own_refusal() {
        assert_eq!(
            parse_read_only_file("/x", b"NMI_FILE\0not-a-size\0hello").unwrap_err(),
            "File returned an invalid size."
        );
        assert_eq!(
            parse_read_only_file("/x", b"NOT_A_HEADER\010\0hello").unwrap_err(),
            "File returned an unexpected response."
        );
    }
}
