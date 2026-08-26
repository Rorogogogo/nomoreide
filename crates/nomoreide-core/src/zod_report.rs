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
    /// A missing *enum* field, whose `expected` is the option list rather than
    /// a type name — and which puts `expected` ahead of the code.
    RequiredEnum {
        expected: String,
        received: &'static str,
        code: &'static str,
        path: Vec<Value>,
        message: &'static str,
    },
    /// `received` comes **first** here, ahead of the code.
    Enum {
        received: String,
        code: &'static str,
        options: Vec<&'static str>,
        path: Vec<Value>,
        message: String,
    },
    /// A discriminated union whose discriminator was not one of its literals.
    /// Zod reports this once, rather than reporting every arm's failure.
    Discriminator {
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

    /// A field that was not there at all. Zod does not say "expected string,
    /// received undefined" in the message for this one — it says `Required`,
    /// even though the `expected`/`received` fields say exactly that.
    pub fn required(expected: &'static str, path: Vec<Value>) -> Self {
        ZodIssue::Type {
            code: "invalid_type",
            expected,
            received: "undefined",
            path,
            message: "Required".to_string(),
        }
    }

    /// The enum flavour of [`Self::required`].
    pub fn required_enum(options: &[&'static str], path: Vec<Value>) -> Self {
        ZodIssue::RequiredEnum {
            expected: options
                .iter()
                .map(|option| format!("'{option}'"))
                .collect::<Vec<_>>()
                .join(" | "),
            received: "undefined",
            code: "invalid_type",
            path,
            message: "Required",
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

    /// A string or array that was present but shorter than its minimum. Zod
    /// reports the `type` it was measuring, which is why these are two
    /// constructors and not one.
    pub fn too_small_string(minimum: i64, path: Vec<Value>) -> Self {
        ZodIssue::TooSmall {
            code: "too_small",
            minimum,
            kind: "string",
            inclusive: true,
            exact: false,
            message: format!("String must contain at least {minimum} character(s)"),
            path,
        }
    }

    pub fn too_small_array(minimum: i64, path: Vec<Value>) -> Self {
        ZodIssue::TooSmall {
            code: "too_small",
            minimum,
            kind: "array",
            inclusive: true,
            exact: false,
            message: format!("Array must contain at least {minimum} element(s)"),
            path,
        }
    }

    pub fn bad_discriminator(options: &[&'static str], path: Vec<Value>) -> Self {
        let rendered = options
            .iter()
            .map(|option| format!("'{option}'"))
            .collect::<Vec<_>>()
            .join(" | ");
        ZodIssue::Discriminator {
            code: "invalid_union_discriminator",
            options: options.to_vec(),
            path,
            message: format!("Invalid discriminator value. Expected {rendered}"),
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
