use crate::contract::registry;
use serde_json::{json, Map, Value};

const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
const LOGGING_LEVELS: &[&str] = &[
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency",
];

pub(crate) struct McpSession;

impl McpSession {
    pub(crate) fn handle_line(&mut self, line: &str) -> Option<Value> {
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => return Some(error(Value::Null, -32700, "Parse error", None)),
        };
        self.handle_value(value)
    }

    fn handle_value(&mut self, value: Value) -> Option<Value> {
        let object = match value.as_object() {
            Some(object) => object,
            None => return Some(error(Value::Null, -32600, "Invalid Request", None)),
        };
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(error(Value::Null, -32600, "Invalid Request", None));
        }
        let method = match object.get("method").and_then(Value::as_str) {
            Some(method) => method,
            None => return Some(error(Value::Null, -32600, "Invalid Request", None)),
        };
        let id = match object.get("id") {
            Some(id) if valid_id(id) => Some(id.clone()),
            Some(_) => return Some(error(Value::Null, -32600, "Invalid Request", None)),
            None => None,
        };

        let id = id?;
        match method {
            "initialize" => Some(match initialize(object.get("params")) {
                Some(result) => success(id, result),
                None => error(id, -32602, "Invalid params", None),
            }),
            "ping" => Some(success(id, json!({}))),
            "tools/list" => Some(if valid_list_params(object.get("params")) {
                success(id, json!({ "tools": registry().tools() }))
            } else {
                error(id, -32602, "Invalid params", None)
            }),
            "tools/call" => Some(self.call_tool(id, object.get("params"))),
            "logging/setLevel" => Some(if valid_logging_params(object.get("params")) {
                success(id, json!({}))
            } else {
                error(id, -32602, "Invalid params", None)
            }),
            "completion/complete" => Some(completion(id, object.get("params"))),
            _ => Some(error(id, -32601, "Method not found", None)),
        }
    }

    fn call_tool(&self, id: Value, params: Option<&Value>) -> Value {
        let params = match params.and_then(Value::as_object) {
            Some(params) => params,
            None => return error(id, -32602, "Invalid params", None),
        };
        let name = match params.get("name").and_then(Value::as_str) {
            Some(name) => name,
            None => return error(id, -32602, "Invalid params", None),
        };
        if !matches!(params.get("arguments"), None | Some(Value::Object(_))) {
            return error(id, -32602, "Invalid params", None);
        }

        if !registry().contains(name) {
            return error(
                id,
                -32601,
                &format!("MCP error -32601: Unknown tool: {name}"),
                None,
            );
        }

        error(
            id,
            -32001,
            &format!(
                "Tool '{name}' is not implemented by the native runtime in migration phase 1."
            ),
            Some(json!({
                "kind": "not_implemented",
                "tool": name,
                "migrationPhase": 1
            })),
        )
    }
}

fn initialize(params: Option<&Value>) -> Option<Value> {
    let params = params?.as_object()?;
    let requested_version = params.get("protocolVersion")?.as_str()?;
    params.get("capabilities")?.as_object()?;
    let client = params.get("clientInfo")?.as_object()?;
    client.get("name")?.as_str()?;
    client.get("version")?.as_str()?;

    let negotiated_version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested_version) {
        requested_version
    } else {
        LATEST_PROTOCOL_VERSION
    };
    let mut result = registry().initialize().clone();
    result["protocolVersion"] = json!(negotiated_version);
    Some(result)
}

fn valid_list_params(params: Option<&Value>) -> bool {
    match params {
        None => true,
        Some(Value::Object(params)) => params.get("cursor").map_or(true, Value::is_string),
        Some(_) => false,
    }
}

fn valid_logging_params(params: Option<&Value>) -> bool {
    params
        .and_then(Value::as_object)
        .and_then(|params| params.get("level"))
        .and_then(Value::as_str)
        .is_some_and(|level| LOGGING_LEVELS.contains(&level))
}

fn completion(id: Value, params: Option<&Value>) -> Value {
    let params = match params.and_then(Value::as_object) {
        Some(params) => params,
        None => return error(id, -32602, "Invalid params", None),
    };
    let reference = match params.get("ref").and_then(Value::as_object) {
        Some(reference) => reference,
        None => return error(id, -32602, "Invalid params", None),
    };
    let _argument = match params.get("argument").and_then(Value::as_object) {
        Some(argument)
            if argument.get("name").is_some_and(Value::is_string)
                && argument.get("value").is_some_and(Value::is_string) =>
        {
            argument
        }
        _ => return error(id, -32602, "Invalid params", None),
    };
    match reference.get("type").and_then(Value::as_str) {
        Some("ref/prompt") if reference.get("name").is_some_and(Value::is_string) => {
            error(id, -32603, "Unknown prompt", None)
        }
        Some("ref/resource") if reference.get("uri").is_some_and(Value::is_string) => {
            error(id, -32603, "Unknown resource", None)
        }
        _ => error(id, -32602, "Invalid params", None),
    }
}

fn valid_id(id: &Value) -> bool {
    match id {
        Value::String(_) => true,
        Value::Number(number) => number.is_i64() || number.is_u64(),
        _ => false,
    }
}

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut detail = Map::new();
    detail.insert("code".to_string(), json!(code));
    detail.insert("message".to_string(), json!(message));
    if let Some(data) = data {
        detail.insert("data".to_string(), data);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": detail })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(session: &mut McpSession, value: Value) -> Value {
        session
            .handle_line(&serde_json::to_string(&value).unwrap())
            .unwrap()
    }

    #[test]
    fn known_but_unported_tools_have_a_typed_migration_error() {
        let response = request(
            &mut McpSession,
            json!({
                "jsonrpc": "2.0",
                "id": "call-1",
                "method": "tools/call",
                "params": { "name": "nomoreide_status", "arguments": {} }
            }),
        );
        assert_eq!(response["id"], "call-1");
        assert_eq!(response["error"]["code"], -32001);
        assert_eq!(response["error"]["data"]["kind"], "not_implemented");
        assert_eq!(response["error"]["data"]["tool"], "nomoreide_status");
    }

    #[test]
    fn unknown_tools_are_not_reported_as_migration_placeholders() {
        let response = request(
            &mut McpSession,
            json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": { "name": "missing", "arguments": {} }
            }),
        );
        assert_eq!(response["error"]["code"], -32601);
        assert_eq!(response["error"].get("data"), None);
    }

    #[test]
    fn initialize_validates_params_and_negotiates_supported_versions() {
        let mut session = McpSession;
        let invalid = request(
            &mut session,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
        );
        assert_eq!(invalid["error"]["code"], -32602);

        let supported = request(
            &mut session,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "1" }
                }
            }),
        );
        assert_eq!(supported["result"]["protocolVersion"], "2024-11-05");

        let unsupported = request(
            &mut session,
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "initialize",
                "params": {
                    "protocolVersion": "1900-01-01",
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "1" }
                }
            }),
        );
        assert_eq!(
            unsupported["result"]["protocolVersion"],
            LATEST_PROTOCOL_VERSION
        );
    }

    #[test]
    fn advertised_capability_methods_are_registered() {
        let mut session = McpSession;
        let logging = request(
            &mut session,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "logging/setLevel",
                "params": { "level": "warning" }
            }),
        );
        assert_eq!(logging["result"], json!({}));

        let completion = request(
            &mut session,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "completion/complete",
                "params": {
                    "ref": { "type": "ref/prompt", "name": "missing" },
                    "argument": { "name": "topic", "value": "" }
                }
            }),
        );
        assert_eq!(completion["error"]["code"], -32603);
        assert_ne!(completion["error"]["code"], -32601);
    }
}
