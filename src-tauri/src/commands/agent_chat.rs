use std::collections::HashMap;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use crate::AppState;

const PREVIEW_LIMIT: usize = 400;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_agent_chat_status() -> Result<Value, String> {
    let claude_ok = Command::new("claude").arg("--version")
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().await.map(|s| s.success()).unwrap_or(false);

    let codex_ok = !claude_ok && Command::new("codex").arg("--version")
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().await.map(|s| s.success()).unwrap_or(false);

    if claude_ok {
        Ok(json!({
            "configured": true,
            "approvals": false,
            "provider": {
                "id": "claude",
                "label": "Claude Code",
                "commandName": "claude",
                "installHint": "",
                "intro": "Claude Code is running in your workspace with full tools — e.g. \"restart the api\", \"what changed in git?\", \"fix the failing test\"."
            }
        }))
    } else if codex_ok {
        Ok(json!({
            "configured": true,
            "approvals": false,
            "provider": {
                "id": "codex",
                "label": "Codex",
                "commandName": "codex",
                "installHint": "",
                "intro": "Codex is running in your workspace with full tools."
            }
        }))
    } else {
        Ok(json!({
            "configured": false,
            "approvals": false,
            "provider": {
                "id": "claude",
                "label": "Claude Code",
                "commandName": "claude",
                "installHint": "Install Claude Code and run `claude login` so it is on PATH, then reload.",
                "intro": ""
            }
        }))
    }
}

// ---------------------------------------------------------------------------
// Start (non-blocking — streams via Tauri events)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_agent_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    message: String,
    resume_session_id: Option<String>,
    provider: Option<String>,
) -> Result<(), String> {
    let config = state.config_store.load().await.map_err(|e| e.to_string())?;
    let cwd = config.selected_git_repository
        .as_ref()
        .and_then(|sel| config.git_repositories.iter().find(|r| &r.name == sel))
        .or_else(|| config.git_repositories.first())
        .map(|r| r.path.clone())
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_default().to_string_lossy().into_owned()
        });

    let provider = provider.as_deref().unwrap_or("claude");
    let is_codex = provider == "codex";
    let bin = if is_codex { "codex" } else { "claude" };
    let args = if is_codex {
        build_codex_args(&message, resume_session_id.as_deref())
    } else {
        build_claude_args(&message, resume_session_id.as_deref())
    };

    let child = Command::new(bin)
        .args(&args)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("Could not find '{bin}'. Please install it and ensure it is on PATH.")
            } else {
                e.to_string()
            }
        })?;

    tokio::spawn(run_agent(app, child, is_codex));
    Ok(())
}

// ---------------------------------------------------------------------------
// CLI argument builders
// ---------------------------------------------------------------------------

fn build_claude_args(message: &str, resume_session_id: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
    ];
    if let Some(sid) = resume_session_id {
        args.push("--resume".to_string());
        args.push(sid.to_string());
    }
    args.push(message.to_string());
    args
}

fn build_codex_args(message: &str, resume_session_id: Option<&str>) -> Vec<String> {
    let mut args = vec!["-a".to_string(), "always".to_string(), "exec".to_string()];
    if let Some(sid) = resume_session_id {
        args.push("resume".to_string());
        args.push("--json".to_string());
        args.push("--skip-git-repo-check".to_string());
        args.push(sid.to_string());
        args.push(message.to_string());
    } else {
        args.push("--json".to_string());
        args.push("--skip-git-repo-check".to_string());
        args.push(message.to_string());
    }
    args
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

async fn run_agent(app: AppHandle, mut child: tokio::process::Child, is_codex: bool) {
    let mut tool_names: HashMap<String, String> = HashMap::new();

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = app.emit("agent-chat-event", json!({"type":"error","message":"No stdout pipe"}));
            return;
        }
    };

    // Drain stderr into a buffer so it doesn't block stdout.
    let stderr_buf = std::sync::Arc::new(tokio::sync::Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut b = buf.lock().await;
                b.push_str(&line);
                b.push('\n');
            }
        });
    }

    let mut lines = BufReader::new(stdout).lines();
    let mut done_sent = false;

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() { continue; }

        let event = if is_codex {
            handle_codex_line(&line, &mut tool_names)
        } else {
            handle_claude_line(&line, &mut tool_names)
        };

        if let Some(event) = event {
            if event.get("type").and_then(|t| t.as_str()) == Some("done") {
                done_sent = true;
            }
            let _ = app.emit("agent-chat-event", event);
        }
    }

    let status = child.wait().await.ok();

    if let Some(status) = status {
        if !status.success() {
            let stderr = stderr_buf.lock().await;
            let msg = stderr.trim().to_string();
            if !msg.is_empty() {
                let _ = app.emit("agent-chat-event", json!({"type":"error","message": msg}));
            }
        }
    }

    if !done_sent {
        let _ = app.emit("agent-chat-event", json!({"type":"done","stopReason": null}));
    }
}

// ---------------------------------------------------------------------------
// Claude stream-json line parser
// ---------------------------------------------------------------------------

fn handle_claude_line(line: &str, tool_names: &mut HashMap<String, String>) -> Option<Value> {
    let obj: Value = serde_json::from_str(line).ok()?;

    match obj.get("type")?.as_str()? {
        "system" => {
            if obj.get("subtype")?.as_str()? == "init" {
                let sid = obj.get("session_id")?.as_str()?;
                return Some(json!({"type":"session","sessionId": sid}));
            }
            None
        }
        "stream_event" => {
            let event = obj.get("event")?;
            if event.get("type")?.as_str()? == "content_block_delta" {
                let delta = event.get("delta")?;
                if delta.get("type")?.as_str()? == "text_delta" {
                    let text = delta.get("text")?.as_str()?;
                    return Some(json!({"type":"text","text": text}));
                }
            }
            None
        }
        "assistant" => {
            let content = obj.get("message")?.get("content")?.as_array()?;
            for block in content {
                if block.get("type")?.as_str()? == "tool_use" {
                    let id = block.get("id")?.as_str()?.to_string();
                    let name = block.get("name")?.as_str()?.to_string();
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    tool_names.insert(id.clone(), name.clone());
                    return Some(json!({"type":"tool_use","id": id,"name": name,"input": input}));
                }
            }
            None
        }
        "user" => {
            let content = obj.get("message")?.get("content")?.as_array()?;
            for block in content {
                if block.get("type")?.as_str()? == "tool_result" {
                    let id = block.get("tool_use_id")?.as_str()?.to_string();
                    let name = tool_names.get(&id).cloned().unwrap_or_else(|| "tool".to_string());
                    let preview = preview_of(block.get("content"));
                    let is_error = block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                    return Some(json!({"type":"tool_result","id": id,"name": name,"preview": preview,"isError": is_error}));
                }
            }
            None
        }
        "result" => {
            let stop = obj.get("subtype").and_then(|v| v.as_str());
            Some(json!({"type":"done","stopReason": stop}))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Codex --json line parser
// ---------------------------------------------------------------------------

fn handle_codex_line(line: &str, tool_names: &mut HashMap<String, String>) -> Option<Value> {
    let obj: Value = serde_json::from_str(line).ok()?;

    match obj.get("type")?.as_str()? {
        "thread.started" => {
            let tid = obj.get("thread_id")?.as_str()?;
            Some(json!({"type":"session","sessionId": tid}))
        }
        evt @ ("item.started" | "item.completed") => {
            let is_completed = evt == "item.completed";
            let item = obj.get("item")?;
            let id = item.get("id")?.as_str()?.to_string();
            let item_type = item.get("type")?.as_str()?;

            if item_type == "command_execution" {
                tool_names.insert(id.clone(), "command".to_string());
                if !is_completed {
                    let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    return Some(json!({"type":"tool_use","id": id,"name":"command","input":{"command": command}}));
                }
                let preview = preview_of(item.get("aggregated_output"));
                let is_error = item.get("exit_code").and_then(|v| v.as_i64()).map(|c| c != 0)
                    .or_else(|| item.get("status").and_then(|v| v.as_str()).map(|s| s == "failed"))
                    .unwrap_or(false);
                return Some(json!({"type":"tool_result","id": id,"name":"command","preview": preview,"isError": is_error}));
            }

            if item_type == "agent_message" && is_completed {
                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if !text.is_empty() {
                    return Some(json!({"type":"text","text": text}));
                }
            }
            None
        }
        "turn.completed" => Some(json!({"type":"done","stopReason": null})),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn preview_of(content: Option<&Value>) -> String {
    let text = match content {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr.iter().map(|b| match b {
            Value::String(s) => s.clone(),
            Value::Object(o) => o.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            _ => String::new(),
        }).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    };
    let text = text.trim().to_string();
    if text.len() > PREVIEW_LIMIT {
        format!("{}…", &text[..PREVIEW_LIMIT])
    } else {
        text
    }
}
