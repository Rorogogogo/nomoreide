//! Turning a catalog object into a file someone downloads.
//!
//! Everything here is formatting: what a cell looks like in CSV, what the
//! whole document looks like in JSON, and what the file is called. None of it
//! touches a database. That matters because two surfaces produce these
//! files -- the dashboard's export route and the desktop app's save-to-disk
//! command -- and a person opening the two downloads has to get the same bytes.
//!
//! The CSV rules are the ones a spreadsheet forces:
//!
//! * A cell that opens with `=`, `+`, `-`, `@`, a tab, or a carriage return is
//!   a **formula** to Excel and Sheets, so it is prefixed with an apostrophe.
//!   Only strings get that treatment: a negative *number* is a number, and
//!   quoting it would be wrong in the other direction.
//! * A cell containing a comma, a quote, a carriage return, or a newline is
//!   wrapped in quotes, and any quote inside is doubled.
//! * Rows end `\r\n`, which is what the format says even though almost nothing
//!   requires it any more.
//!
//! A column whose *name* looks like a secret is bulleted out, exactly as the
//! row browser bullets it. An export is the easiest way to walk off with a
//! table, so the one place it must not become a way around the masking is
//! here.

use super::sql::{is_sensitive_preview_column, quote_identifier};
use super::types::{CatalogObject, ColumnInfo};
use crate::config::DatabaseDef;
use serde_json::Value;

/// The two formats the route offers, matched exactly -- `CSV` is not `csv`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExportFormat {
    Csv,
    Json,
}

impl ExportFormat {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "csv" => Some(Self::Csv),
            "json" => Some(Self::Json),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Csv => "text/csv; charset=utf-8",
            Self::Json => "application/json; charset=utf-8",
        }
    }
}

/// Builds an export a chunk at a time.
///
/// Chunked rather than all-at-once so that a caller writing to a file, a socket
/// or a buffer all drive it the same way, and so a large table never has to
/// exist as one string.
pub struct ExportWriter {
    format: ExportFormat,
    columns: Vec<String>,
    first_json_row: bool,
}

impl ExportWriter {
    /// The writer, and the chunk that opens the document.
    pub fn new(format: ExportFormat, columns: &[ColumnInfo]) -> (Self, String) {
        let columns = columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        let head = match format {
            ExportFormat::Csv => csv_row(
                columns
                    .iter()
                    .map(|name| csv_cell(&Value::String(name.clone()))),
            ),
            ExportFormat::Json => "[".to_string(),
        };
        (
            Self {
                format,
                columns,
                first_json_row: true,
            },
            head,
        )
    }

    /// One row, in the column order the header promised.
    pub fn row(&mut self, values: Vec<Value>) -> String {
        let masked = self
            .columns
            .iter()
            .cloned()
            .zip(values)
            .map(|(column, value)| {
                let value = if is_sensitive_preview_column(&column) && !value.is_null() {
                    Value::String("••••".into())
                } else {
                    value
                };
                (column, value)
            })
            .collect::<Vec<_>>();
        match self.format {
            ExportFormat::Csv => csv_row(masked.iter().map(|(_, value)| csv_cell(value))),
            ExportFormat::Json => {
                let separator = if self.first_json_row { "" } else { "," };
                self.first_json_row = false;
                format!(
                    "{separator}{}",
                    json_object(masked.iter().map(|(key, value)| (key.as_str(), value)))
                )
            }
        }
    }

    /// The chunk that closes the document. CSV needs none; JSON needs its
    /// bracket, and the newline after it that the reference writes.
    pub fn finish(&self) -> String {
        match self.format {
            ExportFormat::Csv => String::new(),
            ExportFormat::Json => "]\n".to_string(),
        }
    }
}

/// A number spelled the way JavaScript spells it.
///
/// The reference builds these files in Node, so the file a person opens carries
/// JavaScript's rendering of every number, and Rust's differs in four places: a
/// whole float keeps no `.0`, negative zero is just zero, the switch to
/// exponent notation happens at 1e21 rather than wherever the formatter feels
/// like it, and below that the digits are written out in full. Above it,
/// `serde_json`'s own spelling already agrees.
fn js_number(number: f64) -> String {
    if number == 0.0 {
        // Covers -0.0, which JavaScript prints as "0" and `{:.0}` as "-0".
        return "0".to_string();
    }
    if !number.is_finite() {
        // Unreachable through JSON, which has no such values, but printing
        // "NaN" into a document is worse than printing nothing.
        return String::new();
    }
    if number.fract() == 0.0 && number.abs() < 1e21 {
        return format!("{number:.0}");
    }
    serde_json::Number::from_f64(number)
        .map(|number| number.to_string())
        .unwrap_or_default()
}

/// One JSON value, with every number spelled JavaScript's way.
///
/// `serde_json::to_string` would be enough for everything else, but it renders
/// numbers its own way and there is no hook to change that, so the containers
/// are walked here to reach the numbers inside them. Strings, and the escaping
/// they need, are still serde's.
fn json_value(value: &Value) -> String {
    match value {
        Value::Number(number) => match number.as_f64() {
            // An integer keeps its own spelling: it may be larger than a double
            // can hold exactly, and rewriting it through one would lose digits.
            Some(float) if number.is_f64() => js_number(float),
            _ => number.to_string(),
        },
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(json_value).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => json_object(map.iter().map(|(key, value)| (key.as_str(), value))),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn json_object<'a>(entries: impl Iterator<Item = (&'a str, &'a Value)>) -> String {
    format!(
        "{{{}}}",
        entries
            .map(|(key, value)| format!(
                "{}:{}",
                serde_json::to_string(key).unwrap_or_default(),
                json_value(value)
            ))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn csv_row(cells: impl Iterator<Item = String>) -> String {
    format!("{}\r\n", cells.collect::<Vec<_>>().join(","))
}

/// One CSV cell.
///
/// A string is the value itself; anything else is its JSON spelling, which is
/// how a number keeps its shape and a blob or a JSON column stays readable.
/// Only the string branch can be mistaken for a formula, so only it is
/// prefixed.
pub fn csv_cell(value: &Value) -> String {
    let (text, from_string) = match value {
        Value::Null => (String::new(), false),
        Value::String(text) => (text.clone(), true),
        other => (json_value(other), false),
    };
    let dangerous = from_string
        && (text.starts_with(['\t', '\r']) || text.trim_start().starts_with(['=', '+', '-', '@']));
    let text = if dangerous { format!("'{text}") } else { text };
    if text.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

/// What the downloaded file is called.
///
/// Built from two names a person chose and a date, then reduced to the
/// characters a filename can carry everywhere. `date` is passed in rather than
/// read from the clock so that the caller decides what "today" means.
pub fn export_filename(connection: &str, object: &str, format: ExportFormat, date: &str) -> String {
    let raw = format!("{connection}-{object}-{date}");
    let mut stem = String::with_capacity(raw.len());
    let mut pending_dash = false;
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            if pending_dash && !stem.is_empty() {
                stem.push('-');
            }
            pending_dash = false;
            stem.push(character);
        } else {
            pending_dash = true;
        }
    }
    let stem = stem.trim_matches('-');
    let stem: String = stem.chars().take(120).collect();
    let stem = stem.trim_end_matches('-');
    let stem = if stem.is_empty() {
        "database-export"
    } else {
        stem
    };
    format!("{stem}.{}", format.extension())
}

/// The header that makes a browser save the file rather than show it.
///
/// Both spellings are written: the quoted ASCII one every client understands,
/// and the RFC 5987 one that carries characters the first cannot. A quote or a
/// newline in the ASCII form would end the header early, so those become
/// underscores.
pub fn content_disposition(filename: &str) -> String {
    let ascii = filename
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\r' | '\n' => '_',
            other => other,
        })
        .collect::<String>();
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent_encode(filename)
    )
}

/// `encodeURIComponent`, which leaves more alone than most percent-encoders.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The statement that reads an object for export, ordered so the file is the
/// same file twice.
///
/// A primary key orders it when there is one. When there is not, every column
/// does -- which is not a *total* order if the table holds duplicate rows, but
/// it is the best a table without a key offers, and it is what the reference
/// asks for. Text ordering is spelled per engine so that the sort does not
/// change with the server's collation.
pub fn export_sql(
    database: &DatabaseDef,
    object: &CatalogObject,
    columns: &[ColumnInfo],
) -> String {
    let engine = database.engine.as_str();
    let table = if engine == "sqlite" {
        quote_identifier(&object.name, engine)
    } else {
        format!(
            "{}.{}",
            quote_identifier(&object.schema, engine),
            quote_identifier(&object.name, engine)
        )
    };
    let projection = columns
        .iter()
        .map(|column| quote_identifier(&column.name, engine))
        .collect::<Vec<_>>()
        .join(", ");
    let primary_keys = columns
        .iter()
        .filter(|column| column.primary_key)
        .map(|column| quote_identifier(&column.name, engine))
        .collect::<Vec<_>>();
    let order_columns = if primary_keys.is_empty() {
        columns
            .iter()
            .map(|column| export_order_expression(engine, column))
            .collect::<Vec<_>>()
    } else {
        primary_keys
    };
    let order = if order_columns.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order_columns.join(", "))
    };
    format!("SELECT {projection} FROM {table}{order}")
}

/// Ordering a column of unknown type without leaning on the server's collation.
///
/// Nulls are separated first, then the value is compared as bytes, so two
/// servers configured differently still hand back the same file.
fn export_order_expression(engine: &str, column: &ColumnInfo) -> String {
    let identifier = quote_identifier(&column.name, engine);
    match engine {
        "postgres" => format!(
            "({identifier} IS NOT NULL), encode(convert_to(CAST({identifier} AS TEXT), 'UTF8'), 'hex') COLLATE \"C\""
        ),
        "mysql" => format!("({identifier} IS NOT NULL), HEX(CAST({identifier} AS BINARY))"),
        _ => format!("typeof({identifier}), hex({identifier})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn column(name: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            data_type: "TEXT".into(),
            nullable: true,
            primary_key: false,
        }
    }

    #[test]
    fn a_plain_cell_is_itself() {
        assert_eq!(csv_cell(&json!("plain")), "plain");
        assert_eq!(csv_cell(&json!(1.5)), "1.5");
        assert_eq!(csv_cell(&Value::Null), "");
        assert_eq!(csv_cell(&json!(true)), "true");
    }

    #[test]
    fn a_cell_that_needs_quoting_gets_it() {
        assert_eq!(csv_cell(&json!("has,comma")), "\"has,comma\"");
        assert_eq!(csv_cell(&json!("has\"quote")), "\"has\"\"quote\"");
        assert_eq!(csv_cell(&json!("multi\nline")), "\"multi\nline\"");
    }

    /// Only a string can be mistaken for a formula. A negative number is a
    /// number.
    #[test]
    fn a_string_that_looks_like_a_formula_is_defused() {
        assert_eq!(csv_cell(&json!("=formula")), "'=formula");
        assert_eq!(csv_cell(&json!("+1")), "'+1");
        assert_eq!(csv_cell(&json!("@home")), "'@home");
        assert_eq!(csv_cell(&json!("  =late")), "'  =late");
        assert_eq!(csv_cell(&json!("\ttabbed")), "'\ttabbed");
        assert_eq!(csv_cell(&json!("-5")), "'-5");
        assert_eq!(csv_cell(&json!(-5)), "-5");
    }

    #[test]
    fn a_secret_looking_column_is_bulleted_in_both_formats() {
        for format in [ExportFormat::Csv, ExportFormat::Json] {
            let (mut writer, _) = ExportWriter::new(format, &[column("id"), column("api_token")]);
            let row = writer.row(vec![json!(1), json!("hunter2")]);
            assert!(row.contains("••••"), "{format:?}: {row}");
            assert!(!row.contains("hunter2"), "{format:?}: {row}");
        }
    }

    /// A null in a secret column stays null rather than becoming bullets --
    /// there is nothing to hide, and hiding it would invent a value.
    #[test]
    fn a_null_secret_stays_null() {
        let (mut writer, _) = ExportWriter::new(ExportFormat::Json, &[column("api_token")]);
        assert_eq!(writer.row(vec![Value::Null]), r#"{"api_token":null}"#);
    }

    #[test]
    fn a_csv_document_opens_with_its_header() {
        let (mut writer, head) = ExportWriter::new(ExportFormat::Csv, &[column("a"), column("b")]);
        assert_eq!(head, "a,b\r\n");
        assert_eq!(writer.row(vec![json!(1), json!("x")]), "1,x\r\n");
        assert_eq!(writer.finish(), "");
    }

    #[test]
    fn a_json_document_is_an_array_ending_in_a_newline() {
        let (mut writer, head) = ExportWriter::new(ExportFormat::Json, &[column("a")]);
        assert_eq!(head, "[");
        assert_eq!(writer.row(vec![json!(1)]), r#"{"a":1}"#);
        assert_eq!(writer.row(vec![json!(2)]), r#",{"a":2}"#);
        assert_eq!(writer.finish(), "]\n");
    }

    #[test]
    fn an_empty_export_is_still_a_document() {
        let (writer, head) = ExportWriter::new(ExportFormat::Json, &[column("a")]);
        assert_eq!(format!("{head}{}", writer.finish()), "[]\n");
        let (writer, head) = ExportWriter::new(ExportFormat::Csv, &[column("a")]);
        assert_eq!(format!("{head}{}", writer.finish()), "a\r\n");
    }

    /// Every one of these was read off the reference's own export, not derived
    /// from the shape of the code.
    #[test]
    fn numbers_are_spelled_the_way_javascript_spells_them() {
        for (value, spelling) in [
            (2.0, "2"),
            (-0.0, "0"),
            (0.0, "0"),
            (-3.0, "-3"),
            (0.1, "0.1"),
            (1e-7, "1e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
        ] {
            assert_eq!(js_number(value), spelling, "{value}");
        }
    }

    #[test]
    fn a_whole_float_loses_its_point_in_both_formats() {
        let (mut writer, _) = ExportWriter::new(ExportFormat::Csv, &[column("v")]);
        assert_eq!(writer.row(vec![json!(2.0)]), "2\r\n");
        let (mut writer, _) = ExportWriter::new(ExportFormat::Json, &[column("v")]);
        assert_eq!(writer.row(vec![json!(2.0)]), r#"{"v":2}"#);
    }

    /// An integer is printed as itself rather than routed through a double,
    /// which would round it once it passed 2^53.
    #[test]
    fn a_large_integer_keeps_every_digit() {
        let (mut writer, _) = ExportWriter::new(ExportFormat::Json, &[column("v")]);
        assert_eq!(
            writer.row(vec![json!(9007199254740993i64)]),
            r#"{"v":9007199254740993}"#
        );
    }

    /// A key with a quote in it still has to come out as valid JSON.
    #[test]
    fn a_column_name_is_escaped_like_any_json_key() {
        let (mut writer, _) = ExportWriter::new(ExportFormat::Json, &[column("a\"b")]);
        assert_eq!(writer.row(vec![json!(1)]), r#"{"a\"b":1}"#);
    }

    #[test]
    fn a_filename_keeps_only_what_a_filesystem_takes() {
        assert_eq!(
            export_filename("demo", "catalogue", ExportFormat::Csv, "2026-08-25"),
            "demo-catalogue-2026-08-25.csv"
        );
        assert_eq!(
            export_filename(
                "odd name/slash",
                "catalogue",
                ExportFormat::Csv,
                "2026-08-25"
            ),
            "odd-name-slash-catalogue-2026-08-25.csv"
        );
        assert_eq!(
            export_filename("main", "v_books", ExportFormat::Json, "2026-08-25"),
            "main-v_books-2026-08-25.json"
        );
    }

    /// A name with nothing a filename can keep still has to produce one.
    #[test]
    fn a_nameless_export_gets_a_name() {
        assert_eq!(
            export_filename("///", "", ExportFormat::Csv, ""),
            "database-export.csv"
        );
    }

    #[test]
    fn the_disposition_carries_both_spellings() {
        assert_eq!(
            content_disposition("demo-catalogue-2026-08-25.csv"),
            "attachment; filename=\"demo-catalogue-2026-08-25.csv\"; filename*=UTF-8''demo-catalogue-2026-08-25.csv"
        );
    }
}
