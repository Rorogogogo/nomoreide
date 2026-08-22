mod contracts;

use crate::contract::registry;
use crate::tools::ToolExecutor;
use contracts::ArgumentContract;
use serde_json::{json, Map, Value};
use std::sync::Arc;

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

pub(crate) struct McpSession {
    executor: Arc<dyn ToolExecutor>,
}

impl McpSession {
    pub(crate) fn new(executor: Arc<dyn ToolExecutor>) -> Self {
        Self { executor }
    }

    pub(crate) async fn handle_line(&mut self, line: &str) -> Option<Value> {
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => return Some(error(Value::Null, -32700, "Parse error", None)),
        };
        self.handle_value(value).await
    }

    async fn handle_value(&mut self, value: Value) -> Option<Value> {
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
            "tools/call" => Some(self.call_tool(id, object.get("params")).await),
            "logging/setLevel" => Some(if valid_logging_params(object.get("params")) {
                success(id, json!({}))
            } else {
                error(id, -32602, "Invalid params", None)
            }),
            "completion/complete" => Some(completion(id, object.get("params"))),
            _ => Some(error(id, -32601, "Method not found", None)),
        }
    }

    async fn call_tool(&self, id: Value, params: Option<&Value>) -> Value {
        let params = match params.and_then(Value::as_object) {
            Some(params) => params,
            None => return error(id, -32602, "Invalid params", None),
        };
        let name = match params.get("name").and_then(Value::as_str) {
            Some(name) => name,
            None => return error(id, -32602, "Invalid params", None),
        };
        let empty_arguments = Map::new();
        let arguments = match params.get("arguments") {
            None => &empty_arguments,
            Some(Value::Object(arguments)) => arguments,
            Some(_) => return error(id, -32602, "Invalid params", None),
        };

        if !registry().contains(name) {
            return error(
                id,
                -32601,
                &format!("MCP error -32601: Unknown tool: {name}"),
                None,
            );
        }

        if let Some(contract) = ArgumentContract::of(name) {
            if let Err(detail) = contract.validate(arguments) {
                return error(
                    id,
                    -32602,
                    &format!(
                        "MCP error -32602: Tool '{name}' parameter validation failed: {detail}. \
                         Please check the parameter types and values according to the tool's schema."
                    ),
                    None,
                );
            }
            return match self.executor.execute(name, arguments).await {
                Ok(text) => success(id, json!({ "content": [{ "type": "text", "text": text }] })),
                Err(message) => success(
                    id,
                    json!({
                        "content": [{
                            "type": "text",
                            "text": format!("Tool '{name}' execution failed: {message}")
                        }],
                        "isError": true
                    }),
                ),
            };
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
    use crate::tools::StaticToolExecutor;

    async fn request(session: &mut McpSession, value: Value) -> Value {
        session
            .handle_line(&serde_json::to_string(&value).unwrap())
            .await
            .unwrap()
    }

    fn session(result: Result<String, String>) -> McpSession {
        McpSession::new(Arc::new(StaticToolExecutor { result }))
    }

    #[tokio::test]
    async fn known_but_unported_tools_have_a_typed_migration_error() {
        let response = request(
            &mut session(Ok(String::new())),
            json!({
                "jsonrpc": "2.0",
                "id": "call-1",
                "method": "tools/call",
                "params": { "name": "nomoreide_list_errors", "arguments": {} }
            }),
        )
        .await;
        assert_eq!(response["id"], "call-1");
        assert_eq!(response["error"]["code"], -32001);
        assert_eq!(response["error"]["data"]["kind"], "not_implemented");
        assert_eq!(response["error"]["data"]["tool"], "nomoreide_list_errors");
    }

    #[tokio::test]
    async fn service_mutations_return_the_runtime_status_as_text_content() {
        for name in [
            "nomoreide_start_service",
            "nomoreide_stop_service",
            "nomoreide_restart_service",
            "nomoreide_start_bundle",
            "nomoreide_stop_bundle",
        ] {
            let response = request(
                &mut session(Ok("{\n  \"name\": \"api\"\n}".into())),
                json!({
                    "jsonrpc": "2.0",
                    "id": name,
                    "method": "tools/call",
                    "params": {
                        "name": name,
                        // The reference strips undeclared arguments instead of
                        // rejecting the call.
                        "arguments": { "name": "api", "ignoredByReference": true }
                    }
                }),
            )
            .await;
            assert_eq!(
                response["result"],
                json!({
                    "content": [{ "type": "text", "text": "{\n  \"name\": \"api\"\n}" }]
                })
            );
        }
    }

    /// Every wording here was read back from the reference implementation, not
    /// derived from zod's documentation: the message an agent sees on a bad
    /// argument is part of the contract this migration promises to preserve.
    #[tokio::test]
    async fn read_logs_rejects_arguments_exactly_as_the_reference_does() {
        for (arguments, detail) in [
            (json!({}), "name: Required"),
            (
                json!({ "name": "" }),
                "name: String must contain at least 1 character(s)",
            ),
            (
                json!({ "name": 5 }),
                "name: Expected string, received number",
            ),
            (
                json!({ "name": "api", "limit": "5" }),
                "limit: Expected number, received string",
            ),
            (
                json!({ "name": "api", "limit": null }),
                "limit: Expected number, received null",
            ),
            (
                json!({ "name": "api", "limit": true }),
                "limit: Expected number, received boolean",
            ),
            (
                json!({ "name": "api", "limit": 1.5 }),
                "limit: Expected integer, received float",
            ),
            (
                json!({ "name": "api", "limit": 0 }),
                "limit: Number must be greater than 0",
            ),
            (
                json!({ "name": "api", "limit": -3 }),
                "limit: Number must be greater than 0",
            ),
            (
                json!({ "name": "api", "limit": 1001 }),
                "limit: Number must be less than or equal to 1000",
            ),
            // A number can fail its type refinement and its range at once, and
            // the reference reports both.
            (
                json!({ "name": "api", "limit": 1000.5 }),
                "limit: Expected integer, received float, limit: Number must be less than or equal to 1000",
            ),
            (
                json!({ "name": "api", "limit": -1.5 }),
                "limit: Expected integer, received float, limit: Number must be greater than 0",
            ),
            // Both fields are reported, in the order the schema declares them.
            (
                json!({ "limit": 0 }),
                "name: Required, limit: Number must be greater than 0",
            ),
        ] {
            let response = request(
                &mut session(Ok(String::new())),
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": { "name": "nomoreide_read_logs", "arguments": arguments }
                }),
            )
            .await;
            assert_eq!(response["error"]["code"], -32602, "{arguments}");
            assert_eq!(
                response["error"]["message"],
                json!(format!(
                    "MCP error -32602: Tool 'nomoreide_read_logs' parameter validation failed: \
                     {detail}. Please check the parameter types and values according to the \
                     tool's schema."
                )),
                "{arguments}"
            );
        }
    }

    /// The bounds are inclusive at the top and exclusive at the bottom, and a
    /// large value written in exponent form is still an integer — the reference
    /// asks whether the *value* is whole, not how it was spelled.
    #[tokio::test]
    async fn read_logs_accepts_the_limits_the_reference_accepts() {
        for arguments in [
            json!({ "name": "api" }),
            json!({ "name": "api", "limit": 1 }),
            json!({ "name": "api", "limit": 1000 }),
            json!({ "name": "api", "limit": 1000, "ignoredByReference": true }),
        ] {
            let response = request(
                &mut session(Ok("[]".into())),
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": { "name": "nomoreide_read_logs", "arguments": arguments }
                }),
            )
            .await;
            assert_eq!(
                response["result"],
                json!({ "content": [{ "type": "text", "text": "[]" }] }),
                "{arguments}"
            );
        }
        // 1e20 is a whole number, so it clears `int` and fails only on range.
        let response = request(
            &mut session(Ok("[]".into())),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "nomoreide_read_logs",
                    "arguments": { "name": "api", "limit": 1e20 }
                }
            }),
        )
        .await;
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("limit: Number must be less than or equal to 1000"));
    }

    /// Read back from the running reference, like the log-tool cases above.
    /// Both fields are optional here, so the interesting cases are the ones
    /// that are present and wrong.
    #[tokio::test]
    async fn timeline_rejects_arguments_exactly_as_the_reference_does() {
        for (arguments, detail) in [
            (
                json!({ "service": "" }),
                "service: String must contain at least 1 character(s)",
            ),
            (
                json!({ "service": 5 }),
                "service: Expected string, received number",
            ),
            (
                json!({ "limit": 0 }),
                "limit: Number must be greater than 0",
            ),
            (
                json!({ "limit": 201 }),
                "limit: Number must be less than or equal to 200",
            ),
            (
                json!({ "limit": 1.5 }),
                "limit: Expected integer, received float",
            ),
            (
                json!({ "limit": null }),
                "limit: Expected number, received null",
            ),
            (
                json!({ "limit": 200.5 }),
                "limit: Expected integer, received float, limit: Number must be less than or equal to 200",
            ),
            (
                json!({ "service": "", "limit": 0 }),
                "service: String must contain at least 1 character(s), limit: Number must be greater than 0",
            ),
        ] {
            let response = request(
                &mut session(Ok(String::new())),
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": { "name": "nomoreide_timeline", "arguments": arguments }
                }),
            )
            .await;
            assert_eq!(
                response["error"]["message"],
                json!(format!(
                    "MCP error -32602: Tool 'nomoreide_timeline' parameter validation failed: \
                     {detail}. Please check the parameter types and values according to the \
                     tool's schema."
                )),
                "{arguments}"
            );
        }
    }

    /// Both fields are optional, so no arguments at all is a valid call — the
    /// whole timeline, at the reference's default depth.
    #[tokio::test]
    async fn timeline_accepts_an_absent_service_and_limit() {
        for arguments in [
            json!({}),
            json!({ "service": "api" }),
            json!({ "limit": 200 }),
            json!({ "service": "api", "limit": 1 }),
        ] {
            let response = request(
                &mut session(Ok("[]".into())),
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": { "name": "nomoreide_timeline", "arguments": arguments }
                }),
            )
            .await;
            assert_eq!(
                response["result"],
                json!({ "content": [{ "type": "text", "text": "[]" }] }),
                "{arguments}"
            );
        }
    }

    #[tokio::test]
    async fn service_mutations_report_daemon_failures_as_tool_errors() {
        let response = request(
            &mut session(Err("Service is not registered.".into())),
            json!({
                "jsonrpc": "2.0",
                "id": 11,
                "method": "tools/call",
                "params": {
                    "name": "nomoreide_start_service",
                    "arguments": { "name": "missing" }
                }
            }),
        )
        .await;
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["content"][0]["text"],
            "Tool 'nomoreide_start_service' execution failed: Service is not registered."
        );
    }

    #[tokio::test]
    async fn service_mutations_reject_invalid_arguments_like_the_reference() {
        let cases = [
            (json!({}), "name: Required"),
            (
                json!({ "name": "" }),
                "name: String must contain at least 1 character(s)",
            ),
            (
                json!({ "name": 7 }),
                "name: Expected string, received number",
            ),
            (
                json!({ "name": null }),
                "name: Expected string, received null",
            ),
            (
                json!({ "name": ["api"] }),
                "name: Expected string, received array",
            ),
        ];
        // The reference gives every service mutation `serviceNameSchema` and
        // every bundle mutation the identically shaped `bundleNameSchema`, so
        // all of them reject the same arguments with the same wording.
        for tool in [
            "nomoreide_start_service",
            "nomoreide_stop_service",
            "nomoreide_restart_service",
            "nomoreide_start_bundle",
            "nomoreide_stop_bundle",
        ] {
            for (arguments, detail) in cases.clone() {
                let response = request(
                    &mut session(Ok("unreachable".into())),
                    json!({
                        "jsonrpc": "2.0",
                        "id": 12,
                        "method": "tools/call",
                        "params": { "name": tool, "arguments": arguments }
                    }),
                )
                .await;
                assert_eq!(response["error"]["code"], -32602);
                assert_eq!(
                    response["error"]["message"],
                    format!(
                        "MCP error -32602: Tool '{tool}' parameter validation \
                         failed: {detail}. Please check the parameter types and values according \
                         to the tool's schema."
                    )
                );
                assert_eq!(response["error"].get("data"), None);
            }
        }
    }

    /// Registration takes eleven fields where a runtime tool takes one, and
    /// the reference reports every one it rejected, in schema order. Each
    /// wording here was read back from the running reference: `kind` alone has
    /// two, depending on whether it had a string to compare.
    #[tokio::test]
    async fn registration_rejects_arguments_exactly_as_the_reference_does() {
        let cases = [
            ("nomoreide_register_service", json!({}), "name: Required"),
            (
                "nomoreide_register_service",
                json!({ "name": "api", "kind": "remote" }),
                "kind: Invalid enum value. Expected 'local' | 'docker-compose' | 'ssh', \
                 received 'remote'",
            ),
            (
                "nomoreide_register_service",
                json!({ "name": "api", "kind": null }),
                "kind: Expected 'local' | 'docker-compose' | 'ssh', received null",
            ),
            (
                "nomoreide_register_service",
                json!({ "name": "api", "command": "" }),
                "command: String must contain at least 1 character(s)",
            ),
            (
                "nomoreide_register_service",
                json!({ "name": "api", "args": "--flag" }),
                "args: Expected array, received string",
            ),
            (
                "nomoreide_register_service",
                json!({ "name": "api", "args": ["ok", 7, {}] }),
                "args.1: Expected string, received number, args.2: Expected string, \
                 received object",
            ),
            // An argv member may be the empty string: it is passed to a program
            // verbatim, and a program may want one.
            (
                "nomoreide_register_service",
                json!({ "name": "api", "args": [""], "port": 70000.5 }),
                "port: Expected integer, received float, port: Number must be less than or \
                 equal to 65535",
            ),
            (
                "nomoreide_register_service",
                json!({ "name": "api", "env": "TOKEN=1" }),
                "env: Expected object, received string",
            ),
            (
                "nomoreide_register_service",
                json!({ "name": "api", "env": { "TOKEN": 1 } }),
                "env.TOKEN: Expected string, received number",
            ),
            // Reported in the reference's own key order, not in the order the
            // caller happened to send them.
            (
                "nomoreide_register_service",
                json!({ "host": "", "cwd": "", "name": 1, "description": 9 }),
                "name: Expected string, received number, cwd: String must contain at least 1 \
                 character(s), description: Expected string, received number, host: String \
                 must contain at least 1 character(s)",
            ),
            (
                "nomoreide_register_bundle",
                json!({}),
                "name: Required, services: Required",
            ),
            (
                "nomoreide_register_bundle",
                json!({ "name": "dev", "services": [] }),
                "services: Array must contain at least 1 element(s)",
            ),
            (
                "nomoreide_register_bundle",
                json!({ "name": "dev", "services": ["api", ""] }),
                "services.1: String must contain at least 1 character(s)",
            ),
            (
                "nomoreide_register_bundle",
                json!({ "name": "dev", "services": 5 }),
                "services: Expected array, received number",
            ),
        ];
        for (tool, arguments, detail) in cases {
            let response = request(
                &mut session(Ok("unreachable".into())),
                json!({
                    "jsonrpc": "2.0",
                    "id": 21,
                    "method": "tools/call",
                    "params": { "name": tool, "arguments": arguments }
                }),
            )
            .await;
            assert_eq!(response["error"]["code"], -32602, "{tool}");
            assert_eq!(
                response["error"]["message"],
                format!(
                    "MCP error -32602: Tool '{tool}' parameter validation \
                     failed: {detail}. Please check the parameter types and values according \
                     to the tool's schema."
                )
            );
        }
    }

    /// A description may be empty, a port may sit at the top of its range, and
    /// nothing but `name` has to be sent at all — the second gate decides
    /// whether the fields describe a service, not this one.
    #[tokio::test]
    async fn registration_accepts_what_the_reference_accepts() {
        for arguments in [
            json!({ "name": "api" }),
            json!({ "name": "api", "kind": "ssh", "description": "", "port": 65535 }),
            json!({ "name": "api", "args": [], "env": {} }),
        ] {
            let response = request(
                &mut session(Ok("registered".into())),
                json!({
                    "jsonrpc": "2.0",
                    "id": 22,
                    "method": "tools/call",
                    "params": { "name": "nomoreide_register_service", "arguments": arguments }
                }),
            )
            .await;
            assert_eq!(response["result"]["content"][0]["text"], "registered");
        }
    }

    #[tokio::test]
    async fn unknown_tools_are_not_reported_as_migration_placeholders() {
        let response = request(
            &mut session(Ok(String::new())),
            json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": { "name": "missing", "arguments": {} }
            }),
        )
        .await;
        assert_eq!(response["error"]["code"], -32601);
        assert_eq!(response["error"].get("data"), None);
    }

    #[tokio::test]
    async fn initialize_validates_params_and_negotiates_supported_versions() {
        let mut session = session(Ok(String::new()));
        let invalid = request(
            &mut session,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
        )
        .await;
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
        )
        .await;
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
        )
        .await;
        assert_eq!(
            unsupported["result"]["protocolVersion"],
            LATEST_PROTOCOL_VERSION
        );
    }

    #[tokio::test]
    async fn advertised_capability_methods_are_registered() {
        let mut session = session(Ok(String::new()));
        let logging = request(
            &mut session,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "logging/setLevel",
                "params": { "level": "warning" }
            }),
        )
        .await;
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
        )
        .await;
        assert_eq!(completion["error"]["code"], -32603);
        assert_ne!(completion["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn argumentless_tools_ignore_whatever_they_are_given() {
        // The reference declares no parameters for these, so nothing about the
        // arguments can fail validation.
        for tool in ["nomoreide_list_services", "nomoreide_status"] {
            let response = request(
                &mut session(Ok("{}".into())),
                json!({
                    "jsonrpc": "2.0",
                    "id": tool,
                    "method": "tools/call",
                    "params": { "name": tool, "arguments": { "unexpected": 1 } }
                }),
            )
            .await;
            assert_eq!(
                response["result"],
                json!({ "content": [{ "type": "text", "text": "{}" }] })
            );
        }
    }

    #[tokio::test]
    async fn list_services_returns_fastmcp_text_content() {
        let response = request(
            &mut session(Ok("{\n  \"services\": [],\n  \"bundles\": []\n}".into())),
            json!({
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {
                    "name": "nomoreide_list_services",
                    "arguments": { "ignoredByReference": true }
                }
            }),
        )
        .await;
        assert_eq!(
            response["result"],
            json!({
                "content": [{
                    "type": "text",
                    "text": "{\n  \"services\": [],\n  \"bundles\": []\n}"
                }]
            })
        );
    }
}
