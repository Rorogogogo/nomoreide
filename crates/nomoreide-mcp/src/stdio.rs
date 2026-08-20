use crate::protocol::McpSession;
use crate::tools::{NativeToolExecutor, ToolExecutor};
use std::io;
use std::sync::Arc;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

pub async fn serve<R, W>(reader: R, writer: &mut W) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    serve_with_executor(reader, writer, Arc::new(NativeToolExecutor::default())).await
}

async fn serve_with_executor<R, W>(
    mut reader: R,
    writer: &mut W,
    executor: Arc<dyn ToolExecutor>,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut session = McpSession::new(executor);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let message = line.trim();
        if message.is_empty() {
            continue;
        }
        if let Some(response) = session.handle_line(message).await {
            let frame = serde_json::to_vec(&response)?;
            writer.write_all(&frame).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }
    }
}

pub async fn run_stdio() -> io::Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    serve(BufReader::new(stdin), &mut stdout).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::StaticToolExecutor;
    use serde_json::{json, Value};
    use std::io::Cursor;

    async fn serve_messages(messages: &[Value]) -> Vec<Value> {
        let input = messages
            .iter()
            .map(|message| serde_json::to_string(message).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let mut output = Vec::new();
        serve_with_executor(
            BufReader::new(Cursor::new(format!("{input}\n"))),
            &mut output,
            Arc::new(StaticToolExecutor {
                result: Ok(String::new()),
            }),
        )
        .await
        .unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn initialization_notification_is_silent_and_tools_are_exact() {
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
        ])
        .await;
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

    #[tokio::test]
    async fn malformed_frames_return_protocol_errors_and_processing_continues() {
        let input = concat!(
            "not-json\n",
            "[]\n",
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1.5,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n",
        );
        let mut output = Vec::new();
        serve_with_executor(
            BufReader::new(Cursor::new(input)),
            &mut output,
            Arc::new(StaticToolExecutor {
                result: Ok(String::new()),
            }),
        )
        .await
        .unwrap();
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
