use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn mcp_subcommand_emits_only_protocol_frames() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_nomoreide"))
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = [
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "integration-test", "version": "1" }
            }
        }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
    ];
    {
        let stdin = child.stdin.as_mut().unwrap();
        for message in input {
            writeln!(stdin, "{}", serde_json::to_string(&message).unwrap()).unwrap();
        }
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "");
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("stdout line must be JSON"))
        .collect();
    assert_eq!(responses.len(), 2);

    let frozen: Value =
        serde_json::from_str(include_str!("../../../test/fixtures/mcp-contract-v1.json")).unwrap();
    assert_eq!(responses[0]["result"], frozen["initialize"]);
    assert_eq!(responses[1]["result"]["tools"], frozen["tools"]);
}
