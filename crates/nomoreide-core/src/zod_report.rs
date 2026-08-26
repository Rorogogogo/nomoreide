//! The validator's report, worded and shaped the way zod words and shapes it.
//!
//! Several routes hand a caller their validator's failure verbatim — the error
//! *is* zod's `message`, which for a `ZodError` is its issue array rendered as
//! pretty JSON. So a client that shows the error shows zod's own report, and
//! matching it means matching the field order too: the key order differs
//! between issue codes, and even between two `invalid_type` issues, because it
//! is whatever order zod happened to build each object in.
//!
//! Only the codes these routes can actually produce are here. Adding a rule to
//! a schema means adding its code, not extending a general one.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ZodIssue {
    /// `expected`/`received` in type terms, with `message` **before** `path`.
    /// This is the shape zod builds for a refinement like `.int()`.
    Refined {
        code: &'static str,
        expected: &'static str,
        received: &'static str,
        message: String,
        path: Vec<Value>,
    },
    /// The same code with `path` before `message`, which is the shape zod
    /// builds when the base type itself is wrong.
    Type {
        code: &'static str,
        expected: &'static str,
        received: &'static str,
        path: Vec<Value>,
        message: String,
    },
    TooSmall {
        code: &'static str,
        minimum: i64,
        #[serde(rename = "type")]
        kind: &'static str,
        inclusive: bool,
        exact: bool,
        message: String,
        path: Vec<Value>,
    },
    TooBig {
        code: &'static str,
        maximum: i64,
        #[serde(rename = "type")]
        kind: &'static str,
        inclusive: bool,
        exact: bool,
        message: String,
        path: Vec<Value>,
    },
    /// `received` comes **first** here, ahead of the code.
    Enum {
        received: String,
        code: &'static str,
        options: Vec<&'static str>,
        path: Vec<Value>,
        message: String,
    },
    UnrecognizedKeys {
        code: &'static str,
        keys: Vec<String>,
        path: Vec<Value>,
        message: String,
    },
}

impl ZodIssue {
    pub fn wrong_type(expected: &'static str, received: &'static str, path: Vec<Value>) -> Self {
        ZodIssue::Type {
            code: "invalid_type",
            expected,
            received,
            path,
            message: format!("Expected {expected}, received {received}"),
        }
    }

    pub fn not_an_integer(path: Vec<Value>) -> Self {
        ZodIssue::Refined {
            code: "invalid_type",
            expected: "integer",
            received: "float",
            message: "Expected integer, received float".to_string(),
            path,
        }
    }

    pub fn too_small(minimum: i64, path: Vec<Value>) -> Self {
        ZodIssue::TooSmall {
            code: "too_small",
            minimum,
            kind: "number",
            inclusive: true,
            exact: false,
            message: format!("Number must be greater than or equal to {minimum}"),
            path,
        }
    }

    pub fn too_big(maximum: i64, path: Vec<Value>) -> Self {
        ZodIssue::TooBig {
            code: "too_big",
            maximum,
            kind: "number",
            inclusive: true,
            exact: false,
            message: format!("Number must be less than or equal to {maximum}"),
            path,
        }
    }

    pub fn bad_enum(received: &str, options: &[&'static str], path: Vec<Value>) -> Self {
        let rendered = options
            .iter()
            .map(|option| format!("'{option}'"))
            .collect::<Vec<_>>()
            .join(" | ");
        ZodIssue::Enum {
            received: received.to_string(),
            code: "invalid_enum_value",
            options: options.to_vec(),
            path,
            message: format!("Invalid enum value. Expected {rendered}, received '{received}'"),
        }
    }

    pub fn unrecognized_keys(keys: Vec<String>, path: Vec<Value>) -> Self {
        let rendered = keys
            .iter()
            .map(|key| format!("'{key}'"))
            .collect::<Vec<_>>()
            .join(", ");
        ZodIssue::UnrecognizedKeys {
            code: "unrecognized_keys",
            keys,
            path,
            message: format!("Unrecognized key(s) in object: {rendered}"),
        }
    }
}

/// A `ZodError`'s `message`: the issue array as pretty JSON, two-space indent.
pub fn report(issues: &[ZodIssue]) -> String {
    serde_json::to_string_pretty(issues).unwrap_or_else(|_| "[]".to_string())
}

/// What zod calls the type of a value it received.
pub fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
