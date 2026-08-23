//! The saved-profile tools.
//!
//! A profile is a file under the user's own config, so none of these needs the
//! daemon — the same reason the agent-environment tools do not.

use crate::tools::render;
use nomoreide_core::agent_env::{Json, OrderedMap};
use nomoreide_core::agent_profiles;
use serde_json::{Map, Value};

pub(crate) fn list() -> Result<String, String> {
    render(&agent_profiles::list()?)
}

pub(crate) fn get(name: &str) -> Result<String, String> {
    render(&agent_profiles::get(name)?)
}

pub(crate) fn create(name: &str, description: Option<&str>) -> Result<String, String> {
    render(&agent_profiles::create(name, description)?)
}

pub(crate) fn update(
    name: &str,
    description: Option<&str>,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    // Absent and empty are different here: an `mcps` that was not sent leaves
    // the profile's servers alone, while an `mcps` of `{}` clears them.
    let mcps = arguments
        .get("mcps")
        .and_then(Value::as_object)
        .map(ordered_documents);
    let skills = arguments
        .get("skills")
        .and_then(Value::as_array)
        .map(documents);
    let plugins = arguments
        .get("plugins")
        .and_then(Value::as_array)
        .map(documents);
    render(&agent_profiles::update(
        name,
        description,
        mcps,
        skills,
        plugins,
    )?)
}

pub(crate) fn delete(name: &str) -> Result<String, String> {
    render(&agent_profiles::delete(name)?)
}

pub(crate) fn copy_items(
    from: &str,
    to: &str,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    render(&agent_profiles::copy_items(
        from,
        to,
        &names(arguments, "mcps"),
        &names(arguments, "skills"),
        &names(arguments, "plugins"),
    )?)
}

fn names(arguments: &Map<String, Value>, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|members| {
            members
                .iter()
                .filter_map(|member| member.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A JSON object carried through unchanged.
///
/// An MCP request reaches this adapter already parsed into a sorted map, so
/// what a caller spelled in one order arrives in another. Nothing can be done
/// about that here — but the profile then keeps whatever order it was handed,
/// which is what a later read has to agree with.
fn ordered_documents(entries: &Map<String, Value>) -> OrderedMap<Json> {
    let mut out = OrderedMap::new();
    for (key, value) in entries {
        out.insert(key.clone(), document(value));
    }
    out
}

fn documents(values: &Vec<Value>) -> Vec<Json> {
    values.iter().map(document).collect()
}

fn document(value: &Value) -> Json {
    serde_json::from_value(value.clone()).unwrap_or(Json::Null)
}
