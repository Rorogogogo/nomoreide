use crate::protocol::McpSession;
use std::io::{self, BufRead, Write};

pub fn serve<R: BufRead, W: Write>(mut reader: R, writer: &mut W) -> io::Result<()> {
    let mut session = McpSession;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let message = line.trim();
        if message.is_empty() {
            continue;
        }
        if let Some(response) = session.handle_line(message) {
            serde_json::to_writer(&mut *writer, &response)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
        }
    }
}

pub fn run_stdio() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    serve(stdin.lock(), &mut stdout.lock())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::Cursor;

    fn serve_messages(messages: &[Value]) -> Vec<Value> {
        let input = messages
            .iter()
            .map(|message| serde_json::to_string(message).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let mut output = Vec::new();
        serve(Cursor::new(format!("{input}\n")), &mut output).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn initialization_notification_is_silent_and_tools_are_exact() {
        let responses = serve_messages(&[
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "1" }
                }
            }),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
        ]);
        assert_eq!(responses.len(), 2);
        assert_eq!(
            responses[0]["result"],
            *crate::contract::registry().initialize()
        );
        assert_eq!(
            responses[1]["result"]["tools"].as_array().unwrap(),
            crate::contract::registry().tools()
        );
        assert_eq!(
            responses[1]["result"]["tools"].as_array().unwrap().len(),
            90
        );
    }

    #[test]
    fn malformed_frames_return_protocol_errors_and_processing_continues() {
        let input = concat!(
            "not-json\n",
            "[]\n",
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1.5,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n",
        );
        let mut output = Vec::new();
        serve(Cursor::new(input), &mut output).unwrap();
        let responses: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 5);
        assert_eq!(responses[0]["error"]["code"], -32700);
        assert_eq!(responses[0]["id"], Value::Null);
        assert_eq!(responses[1]["error"]["code"], -32600);
        assert_eq!(responses[2]["error"]["code"], -32600);
        assert_eq!(responses[2]["id"], Value::Null);
        assert_eq!(responses[3]["error"]["code"], -32600);
        assert_eq!(
            responses[4],
            json!({ "jsonrpc": "2.0", "id": 3, "result": {} })
        );
    }
}
