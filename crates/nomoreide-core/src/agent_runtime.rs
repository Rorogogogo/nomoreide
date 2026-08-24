//! Driving a real agent CLI (Claude Code or Codex) through one headless turn.
//!
//! Both CLIs are run in a machine-readable streaming mode rather than called
//! through a vendor API directly. Conversation continuity is the CLI's own
//! session store: the first turn reports a session id, which a caller sends
//! back as `resume_session_id` on the next turn — this module holds no
//! transcript state of its own.
//!
//! Tool permissions default to gated: a `PreToolUse` hook blocks the CLI on
//! every mutating tool call and asks [`crate::approval_broker::ApprovalBroker`]
//! for a verdict. What is ported here is the orchestration around that hook —
//! building its invocation, streaming its NDJSON output into typed events, and
//! bridging the hook's HTTP request to the broker — not the hook process
//! itself. The hook still runs as its own `node` child of the spawned CLI,
//! which is a real gap against a Node-free deployment; closing it means giving
//! the native binary its own hook subcommand, which is Phase 6 work and is
//! flagged rather than solved here.

use crate::terminal::agent_binary;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// Truncate tool-result previews shown to whoever is watching the run.
const PREVIEW_LIMIT: usize = 400;
/** Tools that trigger an approval prompt (mutating / side-effecting ones). */
const GATED_TOOLS: &str = "Bash|Edit|Write|MultiEdit|NotebookEdit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderId {
    Claude,
    Codex,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Codex => "codex",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(ProviderId::Claude),
            "codex" => Some(ProviderId::Codex),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentChatProvider {
    pub id: ProviderId,
    pub label: &'static str,
    pub command_name: &'static str,
    pub bin: String,
    pub install_hint: &'static str,
    pub intro: &'static str,
}

fn claude_provider() -> AgentChatProvider {
    AgentChatProvider {
        id: ProviderId::Claude,
        label: "Claude Code",
        command_name: "claude",
        bin: agent_binary("NOMOREIDE_CLAUDE_BIN", "claude"),
        install_hint:
            "Install Claude Code (and run `claude login`) so it is on NoMoreIDE's PATH, then reload.",
        intro: "This is real Claude Code, running in your workspace with full tools - e.g. \"restart the api and tail its logs\", \"what changed in git and why?\", \"fix the failing test\".",
    }
}

fn codex_provider() -> AgentChatProvider {
    AgentChatProvider {
        id: ProviderId::Codex,
        label: "Codex",
        command_name: "codex",
        bin: agent_binary("NOMOREIDE_CODEX_BIN", "codex"),
        install_hint:
            "Install Codex CLI (and run `codex login`) so it is on NoMoreIDE's PATH, then reload.",
        intro: "This is real Codex CLI, running in your workspace with full tools - e.g. \"restart the api and tail its logs\", \"what changed in git and why?\", \"fix the failing test\".",
    }
}

/// Every selectable chat provider, in display order.
pub fn chat_providers() -> Vec<AgentChatProvider> {
    vec![claude_provider(), codex_provider()]
}

/// Look up a provider by its id; `None` for an unknown or absent one.
pub fn provider_by_id(id: Option<&str>) -> Option<AgentChatProvider> {
    let id = ProviderId::from_str(id?)?;
    Some(match id {
        ProviderId::Claude => claude_provider(),
        ProviderId::Codex => codex_provider(),
    })
}

/// Pick the in-dock chat provider. An explicit user choice (saved in config)
/// wins; otherwise fall back to the startup-agent detection that the
/// MCP-launched flow relies on; otherwise Claude.
pub fn resolve_chat_provider(detected_name: &str, preferred_id: Option<&str>) -> AgentChatProvider {
    provider_by_id(preferred_id).unwrap_or_else(|| {
        if detected_name == "codex" {
            codex_provider()
        } else {
            claude_provider()
        }
    })
}

/// Whether tool calls are gated behind approval, vs. fully autonomous.
///
/// Codex has no equivalent hook, so gating is Claude-only regardless of the
/// permission mode.
pub fn approvals_enabled(provider: &AgentChatProvider, permission_mode: &str) -> bool {
    provider.id == ProviderId::Claude && permission_mode != "bypassPermissions"
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentInvocation {
    pub bin: String,
    pub args: Vec<String>,
}

/// What the run needs from its caller to build one turn's argv.
pub struct InvocationContext<'a> {
    pub permission_mode: &'a str,
    pub codex_approval_policy: &'a str,
    /// Only called when gating is on — building it touches the filesystem
    /// (the hook script), and an ungated Codex turn never needs it.
    pub approval_settings: &'a (dyn Fn() -> String + Send + Sync),
}

/// Build one turn's argv. Both CLIs take a positional initial prompt and queue
/// it themselves until their TUI/engine is ready, so an empty message simply
/// resumes or starts without one rather than sending a blank turn.
pub fn build_agent_invocation(
    provider: &AgentChatProvider,
    message: &str,
    resume_session_id: Option<&str>,
    gating: bool,
    ctx: &InvocationContext,
) -> AgentInvocation {
    match provider.id {
        ProviderId::Codex => {
            let mut args = vec![
                "-a".to_string(),
                ctx.codex_approval_policy.to_string(),
                "exec".to_string(),
            ];
            if let Some(id) = resume_session_id {
                args.extend([
                    "resume".to_string(),
                    "--json".to_string(),
                    "--skip-git-repo-check".to_string(),
                    id.to_string(),
                    message.to_string(),
                ]);
            } else {
                args.extend([
                    "--json".to_string(),
                    "--skip-git-repo-check".to_string(),
                    message.to_string(),
                ]);
            }
            AgentInvocation {
                bin: provider.bin.clone(),
                args,
            }
        }
        ProviderId::Claude => {
            let mut args = vec![
                "--print".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--include-partial-messages".to_string(),
                "--permission-mode".to_string(),
                if gating {
                    "default".to_string()
                } else {
                    ctx.permission_mode.to_string()
                },
            ];
            if gating {
                args.push("--settings".to_string());
                args.push((ctx.approval_settings)());
            }
            if let Some(id) = resume_session_id {
                args.push("--resume".to_string());
                args.push(id.to_string());
            }
            args.push(message.to_string());
            AgentInvocation {
                bin: provider.bin.clone(),
                args,
            }
        }
    }
}

/// Streamed back to a run's caller.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentStreamEvent {
    Session {
        session_id: String,
    },
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        name: String,
        preview: String,
        is_error: bool,
    },
    ApprovalRequest {
        request_id: String,
        name: String,
        input: Value,
    },
    Done {
        stop_reason: Option<String>,
    },
    Error {
        message: String,
    },
}

/// Parse one NDJSON line from Claude Code's `stream-json` output. Returns the
/// session id when this line is the init event — the caller's cue to open the
/// approval channel.
pub fn handle_claude_line(
    line: &str,
    tool_names: &mut HashMap<String, String>,
    mut on_event: impl FnMut(AgentStreamEvent),
) -> Option<String> {
    let obj: Value = serde_json::from_str(line).ok()?;
    match obj.get("type").and_then(Value::as_str)? {
        "system" => {
            if obj.get("subtype").and_then(Value::as_str) == Some("init") {
                if let Some(session_id) = obj.get("session_id").and_then(Value::as_str) {
                    on_event(AgentStreamEvent::Session {
                        session_id: session_id.to_string(),
                    });
                    return Some(session_id.to_string());
                }
            }
            None
        }
        "stream_event" => {
            let event = obj.get("event")?;
            if event.get("type").and_then(Value::as_str) == Some("content_block_delta")
                && event
                    .get("delta")
                    .and_then(|delta| delta.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta")
            {
                let text = event
                    .get("delta")
                    .and_then(|delta| delta.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                on_event(AgentStreamEvent::Text {
                    text: text.to_string(),
                });
            }
            None
        }
        "assistant" => {
            for block in message_content(obj.get("message")) {
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let (Some(id), Some(name)) =
                        (block.get("id").and_then(Value::as_str), block.get("name"))
                    else {
                        continue;
                    };
                    let name = tool_label(name);
                    tool_names.insert(id.to_string(), name.clone());
                    on_event(AgentStreamEvent::ToolUse {
                        id: id.to_string(),
                        name,
                        input: block.get("input").cloned().unwrap_or(Value::Null),
                    });
                }
            }
            None
        }
        "user" => {
            for block in message_content(obj.get("message")) {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    if let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) {
                        on_event(AgentStreamEvent::ToolResult {
                            id: tool_use_id.to_string(),
                            name: tool_names
                                .get(tool_use_id)
                                .cloned()
                                .unwrap_or_else(|| "tool".to_string()),
                            preview: preview_of(block.get("content")),
                            is_error: block
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        });
                    }
                }
            }
            None
        }
        "result" => {
            on_event(AgentStreamEvent::Done {
                stop_reason: obj
                    .get("subtype")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
            None
        }
        _ => None,
    }
}

/// Parse one JSONL event from `codex exec --json`.
pub fn handle_codex_line(
    line: &str,
    tool_names: &mut HashMap<String, String>,
    mut on_event: impl FnMut(AgentStreamEvent),
) -> Option<String> {
    let obj: Value = serde_json::from_str(line).ok()?;
    let event_type = obj.get("type").and_then(Value::as_str)?;

    if event_type == "thread.started" {
        if let Some(thread_id) = obj.get("thread_id").and_then(Value::as_str) {
            on_event(AgentStreamEvent::Session {
                session_id: thread_id.to_string(),
            });
            return Some(thread_id.to_string());
        }
        return None;
    }

    if event_type == "item.started" || event_type == "item.completed" {
        let item = obj.get("item")?;
        let (Some(id), Some(item_type)) = (
            item.get("id").and_then(Value::as_str),
            item.get("type").and_then(Value::as_str),
        ) else {
            return None;
        };

        if item_type == "command_execution" {
            let name = "command";
            tool_names.insert(id.to_string(), name.to_string());
            let command = item.get("command").and_then(Value::as_str).unwrap_or("");
            if event_type == "item.started" {
                on_event(AgentStreamEvent::ToolUse {
                    id: id.to_string(),
                    name: name.to_string(),
                    input: serde_json::json!({ "command": command }),
                });
                return None;
            }
            let is_error = match item.get("exit_code").and_then(Value::as_i64) {
                Some(code) => code != 0,
                None => item.get("status").and_then(Value::as_str) == Some("failed"),
            };
            on_event(AgentStreamEvent::ToolResult {
                id: id.to_string(),
                name: name.to_string(),
                preview: preview_of(item.get("aggregated_output")),
                is_error,
            });
            return None;
        }

        if item_type == "agent_message" && event_type == "item.completed" {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    on_event(AgentStreamEvent::Text {
                        text: text.to_string(),
                    });
                }
            }
            return None;
        }
        return None;
    }

    if event_type == "turn.completed" {
        on_event(AgentStreamEvent::Done { stop_reason: None });
    }
    None
}

fn message_content(message: Option<&Value>) -> Vec<&Value> {
    message
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| blocks.iter().collect())
        .unwrap_or_default()
}

/// A tool name is rendered as its JSON value's string form, matching the
/// reference's `String(block.name)` — a non-string name (which should not
/// occur) still produces a label rather than being dropped.
fn tool_label(name: &Value) -> String {
    name.as_str()
        .map(str::to_string)
        .unwrap_or_else(|| name.to_string())
}

fn preview_of(content: Option<&Value>) -> String {
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match block {
                Value::String(text) => text.clone(),
                Value::Object(_) => block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    let text = text.trim();
    if text.chars().count() > PREVIEW_LIMIT {
        let truncated: String = text.chars().take(PREVIEW_LIMIT).collect();
        format!("{truncated}\u{2026}")
    } else {
        text.to_string()
    }
}

/// Irreversible / history-rewriting shell that must keep a human in the loop
/// even inside an auto-approved workflow step. Unknown shapes are treated as
/// risky — absence of proof is not proof of safety.
pub fn is_dangerous_bash_command(command: Option<&str>) -> bool {
    let Some(command) = command else { return true };
    let command = command.trim();
    contains(command, r"\brm\s+-[a-zA-Z]*f")
        || contains(command, r"\bgit\b.*\breset\b.*--hard")
        || contains(command, r"\bgit\b.*\bclean\b.*-[a-zA-Z]*f")
        || contains(command, r"\bgit\b.*\bpush\b.*(--force|-f(\s|$))")
        || contains(command, r"\bgit\b.*\bbranch\b.*\s-D\b")
        || command.contains('>')
}

fn contains(haystack: &str, pattern: &str) -> bool {
    regex::Regex::new(pattern)
        .map(|re| re.is_match(haystack))
        .unwrap_or(false)
}

use std::sync::OnceLock;

static HOOK_PATH: OnceLock<String> = OnceLock::new();
static SETTINGS_JSON: OnceLock<String> = OnceLock::new();

/// Inline `--settings` JSON installing the PreToolUse approval hook. Built
/// once and cached, matching the reference — the hook script it points at is
/// itself written once per process.
pub fn approval_settings() -> String {
    SETTINGS_JSON
        .get_or_init(|| {
            let command = format!("node {}", serde_json::to_string(&ensure_hook_script()).unwrap());
            serde_json::json!({
                // NoMoreIDE's own MCP tools are read-safe / scoped to registered
                // services, so auto-allow them. The bare server prefix allows
                // every tool from that server; everything else is left to the
                // PreToolUse hook below.
                "permissions": { "allow": ["mcp__nomoreide"] },
                "hooks": {
                    "PreToolUse": [{ "matcher": GATED_TOOLS, "hooks": [{ "type": "command", "command": command }] }]
                }
            })
            .to_string()
        })
        .clone()
}

/// Write the approval-hook script to a temp file once, runnable by plain
/// `node`. It POSTs the pending tool call to the daemon and blocks until the
/// decision returns, then prints the PreToolUse permission decision the CLI
/// expects.
///
/// **Requires `node` on PATH.** The hook is a child *of the spawned agent
/// CLI*, not of this binary, so it cannot simply be a Rust subcommand without
/// the CLI itself gaining a way to invoke one — that is Phase 6 work (see the
/// module doc comment) and is not solved here. The script's text is ported
/// verbatim for wire parity with what the CLI's hook protocol already expects.
fn ensure_hook_script() -> String {
    HOOK_PATH
        .get_or_init(|| {
            let dir =
                std::env::temp_dir().join(format!("nomoreide-agent-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create hook script directory");
            let path = dir.join("approval-hook.cjs");
            std::fs::write(&path, HOOK_SOURCE).expect("write hook script");
            path.to_string_lossy().into_owned()
        })
        .clone()
}

/// The `PreToolUse` hook script, run by `node` as a child of the spawned agent
/// CLI. Ported verbatim from the reference for wire parity: the CLI's hook
/// protocol (stdin JSON in, permission-decision JSON out) is fixed by the
/// vendor, not by NoMoreIDE, so this text has nothing to diverge over.
const HOOK_SOURCE: &str = r#""use strict";
const http = require("http");
const { randomUUID } = require("crypto");
let body = "";
process.stdin.on("data", (d) => (body += d));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(body); } catch {}
  const cmd = input.tool_input && input.tool_input.command;
  // Auto-allow routine, low-risk Bash (diagnostics + dependency installs) so
  // onboarding doesn't prompt for every step. Anything with shell chaining,
  // redirection, or command substitution — or outside the safe verb list —
  // still falls through to the dock for an explicit Allow/Deny.
  if (input.tool_name === "Bash" && isSafeBash(cmd)) {
    return decide("allow", "Auto-allowed routine command.");
  }
  // Scoped auto-approve for a consented workflow step: let the agent edit files
  // and run non-footgun shell without a prompt for each call. Irreversible
  // footguns (rm -rf, git reset --hard / clean -f / force-push / branch -D, and
  // output redirection) still fall through to the dock for an explicit Allow.
  if (process.env.NOMOREIDE_AUTO_APPROVE === "1") {
    if (input.tool_name !== "Bash") {
      return decide("allow", "Auto-approved within workflow.");
    }
    if (!isDangerousBashCommand(cmd)) {
      return decide("allow", "Auto-approved within workflow.");
    }
  }
  const url = process.env.NOMOREIDE_APPROVAL_URL;
  if (!url) return decide("deny", "Approval channel not configured.");
  let target;
  try { target = new URL(url); } catch { return decide("deny", "Bad approval URL."); }
  const payload = JSON.stringify({
    sessionId: input.session_id,
    requestId: randomUUID(),
    toolName: input.tool_name,
    toolInput: input.tool_input,
  });
  const req = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    },
    (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const r = JSON.parse(data);
          decide(r.decision === "allow" ? "allow" : "deny", r.reason);
        } catch {
          decide("deny", "No decision returned.");
        }
      });
    },
  );
  req.on("error", () => decide("deny", "Approval request failed to reach NoMoreIDE."));
  req.setTimeout(10 * 60 * 1000, () => {
    req.destroy();
    decide("deny", "Approval timed out.");
  });
  req.write(payload);
  req.end();
});
function isSafeBash(cmd) {
  if (typeof cmd !== "string") return false;
  const c = cmd.trim();
  // Reject anything that chains, redirects, or substitutes — keep it one simple
  // command so a safe prefix can't smuggle a dangerous tail (e.g. "echo x; rm -rf").
  if (/[;&|<>$()\`]/.test(c)) return false;
  return /^(echo|pwd|whoami|true|date|ls|node|npm (install|ci|--version|-v)|pnpm (install|--version|-v)|yarn( install| --version| -v)?|bun (install|--version|-v)|pip3? install)/.test(c);
}
function isDangerousBashCommand(cmd) {
  if (typeof cmd !== "string") return true;
  const c = cmd.trim();
  return (
    /\brm\s+-[a-zA-Z]*f/.test(c) ||
    /\bgit\b.*\breset\b.*--hard/.test(c) ||
    /\bgit\b.*\bclean\b.*-[a-zA-Z]*f/.test(c) ||
    /\bgit\b.*\bpush\b.*(--force|-f(\s|$))/.test(c) ||
    /\bgit\b.*\bbranch\b.*\s-D\b/.test(c) ||
    />/.test(c)
  );
}
function decide(permissionDecision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason: reason || "",
      },
    }),
  );
  process.exit(0);
}
"#;

/// Bridges [`Child`] stdout into line-delimited events, and stderr into a
/// buffer the caller can render on a non-zero exit. Kept separate from the run
/// loop so it can be driven by a real `tokio::process::Child` or, in a test, by
/// any `AsyncRead`.
async fn drive_lines(stdout: impl AsyncRead + Unpin, mut on_line: impl FnMut(&str)) {
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            on_line(trimmed);
        }
    }
}

/// What a caller supplies to gate a run behind approval. Absent, the run is
/// autonomous and no hook is installed.
pub struct Approval {
    pub broker: crate::approval_broker::ApprovalBroker,
    /// The URL the hook script POSTs to. Not built here — a caller assembles
    /// it from whatever address the daemon is actually reachable at.
    pub url: String,
    pub auto_approve: bool,
}

/// Run one user turn, streaming events until the CLI exits.
///
/// Events go out over `events` rather than a borrowed callback: an
/// [`AgentStreamEvent::ApprovalRequest`] can arrive from a *different* task —
/// the HTTP handler answering the hook's blocked POST — while this loop is
/// still draining stdout, so the sink has to be something that task can hold
/// too. `events` is that shared handle; a caller wanting synchronous events
/// back drains the paired receiver on another task.
pub struct RunOptions<'a> {
    pub message: &'a str,
    pub resume_session_id: Option<&'a str>,
    pub permission_mode: &'a str,
    pub codex_approval_policy: &'a str,
    pub approval: Option<Approval>,
}

pub async fn run(
    cwd: &str,
    provider: &AgentChatProvider,
    options: RunOptions<'_>,
    events: mpsc::UnboundedSender<AgentStreamEvent>,
) {
    let RunOptions {
        message,
        resume_session_id,
        permission_mode,
        codex_approval_policy,
        approval,
    } = options;
    let gating = approval.is_some() && approvals_enabled(provider, permission_mode);
    let ctx = InvocationContext {
        permission_mode,
        codex_approval_policy,
        approval_settings: &approval_settings,
    };
    let invocation = build_agent_invocation(provider, message, resume_session_id, gating, &ctx);

    let mut command = Command::new(&invocation.bin);
    command
        .args(&invocation.args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if gating {
        if let Some(approval) = approval.as_ref() {
            command.env("NOMOREIDE_APPROVAL_URL", &approval.url);
            if approval.auto_approve {
                command.env("NOMOREIDE_AUTO_APPROVE", "1");
            }
        }
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = if error.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "Could not run \"{}\". {}",
                    invocation.bin, provider.install_hint
                )
            } else {
                error.to_string()
            };
            let _ = events.send(AgentStreamEvent::Error { message });
            return;
        }
    };

    let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
    let stdout = child.stdout.take().expect("piped stdout");
    let stdout_task = tokio::spawn(async move {
        drive_lines(stdout, |line| {
            let _ = line_tx.send(line.to_string());
        })
        .await;
    });

    let stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(collect_stderr(stderr));

    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut opened_session: Option<String> = None;

    while let Some(line) = line_rx.recv().await {
        let events_for_line = events.clone();
        let session_id = match provider.id {
            ProviderId::Codex => handle_codex_line(&line, &mut tool_names, |event| {
                let _ = events_for_line.send(event);
            }),
            ProviderId::Claude => handle_claude_line(&line, &mut tool_names, |event| {
                let _ = events_for_line.send(event);
            }),
        };
        if gating && opened_session.is_none() {
            if let (Some(session_id), Some(approval)) = (session_id, approval.as_ref()) {
                opened_session = Some(session_id.clone());
                let sink = events.clone();
                approval.broker.open_run(
                    &session_id,
                    std::sync::Arc::new(move |request: crate::approval_broker::ApprovalRequest| {
                        let _ = sink.send(AgentStreamEvent::ApprovalRequest {
                            request_id: request.request_id,
                            name: request.name,
                            input: request.input,
                        });
                    }),
                );
            }
        }
    }

    let _ = stdout_task.await;
    let status = child.wait().await;
    let stderr_text = stderr_task.await.unwrap_or_default();

    match status {
        Ok(status) if !status.success() => {
            let code = status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_default();
            let trimmed = stderr_text.trim();
            let message = if !trimmed.is_empty() {
                trimmed.to_string()
            } else {
                format!("{} exited with code {code}.", provider.label)
            };
            let _ = events.send(AgentStreamEvent::Error { message });
        }
        Err(error) => {
            let _ = events.send(AgentStreamEvent::Error {
                message: error.to_string(),
            });
        }
        _ => {}
    }

    if let (Some(session_id), Some(approval)) = (opened_session, approval.as_ref()) {
        approval.broker.close_run(&session_id);
    }
}

async fn collect_stderr(stderr: impl AsyncRead + Unpin) -> String {
    use tokio::io::AsyncReadExt;
    let mut buf = String::new();
    let mut reader = stderr;
    let _ = reader.read_to_string(&mut buf).await;
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude() -> AgentChatProvider {
        claude_provider()
    }
    fn codex() -> AgentChatProvider {
        codex_provider()
    }
    fn ctx<'a>(
        permission_mode: &'a str,
        codex_approval_policy: &'a str,
        settings: &'a (dyn Fn() -> String + Send + Sync),
    ) -> InvocationContext<'a> {
        InvocationContext {
            permission_mode,
            codex_approval_policy,
            approval_settings: settings,
        }
    }

    /// Every case here is pinned to real reference output captured by
    /// `handoffs/probe/agent-runtime-probe.ts`, not derived from reading the
    /// TypeScript.
    mod build_agent_invocation_matches_the_reference {
        use super::*;

        #[test]
        fn claude_fresh_ungated() {
            let settings = || unreachable!("ungated must not build settings");
            let invocation = build_agent_invocation(
                &claude(),
                "hello",
                None,
                false,
                &ctx("default", "never", &settings),
            );
            assert_eq!(invocation.bin, "claude");
            assert_eq!(
                invocation.args,
                vec![
                    "--print",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--permission-mode",
                    "default",
                    "hello",
                ]
            );
        }

        #[test]
        fn claude_fresh_gated() {
            let settings = || "<settings-json>".to_string();
            let invocation = build_agent_invocation(
                &claude(),
                "hello",
                None,
                true,
                &ctx("default", "never", &settings),
            );
            assert_eq!(
                invocation.args,
                vec![
                    "--print",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--permission-mode",
                    "default",
                    "--settings",
                    "<settings-json>",
                    "hello",
                ]
            );
        }

        #[test]
        fn claude_resume_ungated() {
            let settings = || unreachable!();
            let invocation = build_agent_invocation(
                &claude(),
                "again",
                Some("sess-1"),
                false,
                &ctx("default", "never", &settings),
            );
            assert_eq!(
                invocation.args,
                vec![
                    "--print",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--permission-mode",
                    "default",
                    "--resume",
                    "sess-1",
                    "again",
                ]
            );
        }

        #[test]
        fn claude_resume_gated() {
            let settings = || "<settings-json>".to_string();
            let invocation = build_agent_invocation(
                &claude(),
                "again",
                Some("sess-1"),
                true,
                &ctx("default", "never", &settings),
            );
            assert_eq!(
                invocation.args,
                vec![
                    "--print",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--permission-mode",
                    "default",
                    "--settings",
                    "<settings-json>",
                    "--resume",
                    "sess-1",
                    "again",
                ]
            );
        }

        #[test]
        fn claude_empty_message_is_still_a_positional_argument() {
            let settings = || unreachable!();
            let invocation = build_agent_invocation(
                &claude(),
                "",
                None,
                false,
                &ctx("default", "never", &settings),
            );
            assert_eq!(invocation.args.last(), Some(&String::new()));
        }

        #[test]
        fn codex_fresh() {
            let settings = || unreachable!("codex never builds claude settings");
            let invocation = build_agent_invocation(
                &codex(),
                "hello",
                None,
                false,
                &ctx("default", "never", &settings),
            );
            assert_eq!(invocation.bin, "codex");
            assert_eq!(
                invocation.args,
                vec![
                    "-a",
                    "never",
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "hello"
                ]
            );
        }

        #[test]
        fn codex_resume() {
            let settings = || unreachable!();
            let invocation = build_agent_invocation(
                &codex(),
                "again",
                Some("thread-1"),
                false,
                &ctx("default", "never", &settings),
            );
            assert_eq!(
                invocation.args,
                vec![
                    "-a",
                    "never",
                    "exec",
                    "resume",
                    "--json",
                    "--skip-git-repo-check",
                    "thread-1",
                    "again"
                ]
            );
        }

        /// Codex has no hook, so `gating` must not change its argv at all — the
        /// reference produces byte-identical output whether gating is true or
        /// false. This is the case a copy-paste from the Claude branch would
        /// most easily get wrong.
        #[test]
        fn codex_ignores_gating_entirely() {
            let settings = || unreachable!("codex must never call the claude settings builder");
            let ungated = build_agent_invocation(
                &codex(),
                "hi",
                None,
                false,
                &ctx("default", "never", &settings),
            );
            let gated = build_agent_invocation(
                &codex(),
                "hi",
                None,
                true,
                &ctx("default", "never", &settings),
            );
            assert_eq!(ungated, gated);
            assert_eq!(
                gated.args,
                vec![
                    "-a",
                    "never",
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "hi"
                ]
            );
        }

        #[test]
        fn ungated_claude_uses_the_configured_permission_mode() {
            let settings = || unreachable!();
            let invocation = build_agent_invocation(
                &claude(),
                "hi",
                None,
                false,
                &ctx("bypassPermissions", "never", &settings),
            );
            assert!(invocation.args.contains(&"bypassPermissions".to_string()));
            assert!(!invocation.args.contains(&"default".to_string()));
        }
    }

    mod handle_claude_line_matches_the_reference {
        use super::*;
        use serde_json::json;

        fn run(line: &str) -> (Option<String>, Vec<AgentStreamEvent>) {
            let mut tool_names = HashMap::new();
            let mut seen = Vec::new();
            let session = handle_claude_line(line, &mut tool_names, |event| seen.push(event));
            (session, seen)
        }

        #[test]
        fn init_reports_the_session_id() {
            let (session, events) = run(
                &json!({ "type": "system", "subtype": "init", "session_id": "abc-123" })
                    .to_string(),
            );
            assert_eq!(session, Some("abc-123".to_string()));
            assert_eq!(
                events,
                vec![AgentStreamEvent::Session {
                    session_id: "abc-123".to_string()
                }]
            );
        }

        #[test]
        fn init_without_a_session_id_emits_nothing() {
            let (session, events) =
                run(&json!({ "type": "system", "subtype": "init" }).to_string());
            assert_eq!(session, None);
            assert!(events.is_empty());
        }

        #[test]
        fn a_non_init_system_subtype_is_silent() {
            let (_, events) = run(&json!({ "type": "system", "subtype": "other" }).to_string());
            assert!(events.is_empty());
        }

        #[test]
        fn a_text_delta_is_forwarded() {
            let (_, events) = run(
                &json!({
                    "type": "stream_event",
                    "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "hi" } }
                })
                .to_string(),
            );
            assert_eq!(
                events,
                vec![AgentStreamEvent::Text {
                    text: "hi".to_string()
                }]
            );
        }

        #[test]
        fn a_non_text_delta_is_silent() {
            let (_, events) = run(&json!({
                "type": "stream_event",
                "event": { "type": "content_block_delta", "delta": { "type": "input_json_delta" } }
            })
            .to_string());
            assert!(events.is_empty());
        }

        #[test]
        fn a_tool_use_block_is_reported_and_remembered() {
            let mut tool_names = HashMap::new();
            let mut seen = Vec::new();
            let line = json!({
                "type": "assistant",
                "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] }
            })
            .to_string();
            handle_claude_line(&line, &mut tool_names, |event| seen.push(event));
            assert_eq!(
                seen,
                vec![AgentStreamEvent::ToolUse {
                    id: "t1".to_string(),
                    name: "Bash".to_string(),
                    input: json!({ "command": "ls" }),
                }]
            );
            assert_eq!(tool_names.get("t1"), Some(&"Bash".to_string()));
        }

        /// The reference does `String(block.name)` — a non-string name still
        /// produces a label. Pinned against the reference's own output: `7`
        /// becomes the string `"7"`.
        #[test]
        fn a_non_string_tool_name_is_stringified_not_dropped() {
            let (_, events) = run(
                &json!({
                    "type": "assistant",
                    "message": { "content": [{ "type": "tool_use", "id": "t2", "name": 7, "input": {} }] }
                })
                .to_string(),
            );
            assert_eq!(
                events,
                vec![AgentStreamEvent::ToolUse {
                    id: "t2".to_string(),
                    name: "7".to_string(),
                    input: json!({})
                }]
            );
        }

        #[test]
        fn a_tool_result_uses_the_remembered_name() {
            let mut tool_names = HashMap::new();
            tool_names.insert("t1".to_string(), "Bash".to_string());
            let mut seen = Vec::new();
            let line = json!({
                "type": "user",
                "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "output here", "is_error": false }] }
            })
            .to_string();
            handle_claude_line(&line, &mut tool_names, |event| seen.push(event));
            assert_eq!(
                seen,
                vec![AgentStreamEvent::ToolResult {
                    id: "t1".to_string(),
                    name: "Bash".to_string(),
                    preview: "output here".to_string(),
                    is_error: false,
                }]
            );
        }

        #[test]
        fn a_tool_result_for_an_unremembered_id_falls_back_to_tool() {
            let (_, events) = run(
                &json!({
                    "type": "user",
                    "message": { "content": [{ "type": "tool_result", "tool_use_id": "never-seen", "content": "x" }] }
                })
                .to_string(),
            );
            assert_eq!(
                events,
                vec![AgentStreamEvent::ToolResult {
                    id: "never-seen".to_string(),
                    name: "tool".to_string(),
                    preview: "x".to_string(),
                    is_error: false,
                }]
            );
        }

        /// Array content joins string blocks and `{text}` blocks with a space,
        /// dropping anything else silently.
        #[test]
        fn array_content_is_joined() {
            let (_, events) = run(
                &json!({
                    "type": "user",
                    "message": {
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": "t1",
                            "content": [{ "type": "text", "text": "block one" }, "raw string", { "type": "text" }],
                            "is_error": true
                        }]
                    }
                })
                .to_string(),
            );
            let AgentStreamEvent::ToolResult {
                preview, is_error, ..
            } = &events[0]
            else {
                panic!("expected a tool result");
            };
            assert_eq!(preview, "block one raw string");
            assert!(is_error);
        }

        #[test]
        fn a_long_preview_is_truncated_at_the_limit_with_an_ellipsis() {
            let content = "x".repeat(500);
            let (_, events) = run(
                &json!({
                    "type": "user",
                    "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": content }] }
                })
                .to_string(),
            );
            let AgentStreamEvent::ToolResult { preview, .. } = &events[0] else {
                panic!("expected a tool result");
            };
            assert_eq!(preview.chars().count(), PREVIEW_LIMIT + 1);
            assert!(preview.ends_with('\u{2026}'));
            assert_eq!(
                &preview[..PREVIEW_LIMIT],
                "x".repeat(PREVIEW_LIMIT).as_str()
            );
        }

        #[test]
        fn result_reports_done_with_its_subtype() {
            let (_, events) = run(&json!({ "type": "result", "subtype": "success" }).to_string());
            assert_eq!(
                events,
                vec![AgentStreamEvent::Done {
                    stop_reason: Some("success".to_string())
                }]
            );
        }

        #[test]
        fn result_without_a_subtype_reports_done_with_none() {
            let (_, events) = run(&json!({ "type": "result" }).to_string());
            assert_eq!(events, vec![AgentStreamEvent::Done { stop_reason: None }]);
        }

        #[test]
        fn an_unknown_type_is_silent() {
            let (session, events) = run(&json!({ "type": "something_else" }).to_string());
            assert_eq!(session, None);
            assert!(events.is_empty());
        }

        #[test]
        fn malformed_json_is_silent_not_an_error_event() {
            let (session, events) = run("{not json");
            assert_eq!(session, None);
            assert!(events.is_empty());
        }
    }

    mod handle_codex_line_matches_the_reference {
        use super::*;
        use serde_json::json;

        fn run(line: &str) -> (Option<String>, Vec<AgentStreamEvent>) {
            let mut tool_names = HashMap::new();
            let mut seen = Vec::new();
            let session = handle_codex_line(line, &mut tool_names, |event| seen.push(event));
            (session, seen)
        }

        #[test]
        fn thread_started_reports_the_session_id() {
            let (session, events) =
                run(&json!({ "type": "thread.started", "thread_id": "th-1" }).to_string());
            assert_eq!(session, Some("th-1".to_string()));
            assert_eq!(
                events,
                vec![AgentStreamEvent::Session {
                    session_id: "th-1".to_string()
                }]
            );
        }

        #[test]
        fn thread_started_without_an_id_emits_nothing() {
            let (session, events) = run(&json!({ "type": "thread.started" }).to_string());
            assert_eq!(session, None);
            assert!(events.is_empty());
        }

        #[test]
        fn a_command_starting_reports_tool_use_and_remembers_the_name() {
            let mut tool_names = HashMap::new();
            let mut seen = Vec::new();
            let line = json!({ "type": "item.started", "item": { "id": "c1", "type": "command_execution", "command": "ls -la" } })
                .to_string();
            handle_codex_line(&line, &mut tool_names, |event| seen.push(event));
            assert_eq!(
                seen,
                vec![AgentStreamEvent::ToolUse {
                    id: "c1".to_string(),
                    name: "command".to_string(),
                    input: json!({ "command": "ls -la" }),
                }]
            );
            assert_eq!(tool_names.get("c1"), Some(&"command".to_string()));
        }

        #[test]
        fn a_command_completing_successfully_is_not_an_error() {
            let (_, events) = run(
                &json!({
                    "type": "item.completed",
                    "item": { "id": "c1", "type": "command_execution", "aggregated_output": "done", "exit_code": 0 }
                })
                .to_string(),
            );
            assert_eq!(
                events,
                vec![AgentStreamEvent::ToolResult {
                    id: "c1".to_string(),
                    name: "command".to_string(),
                    preview: "done".to_string(),
                    is_error: false,
                }]
            );
        }

        #[test]
        fn a_nonzero_exit_code_is_an_error() {
            let (_, events) = run(
                &json!({
                    "type": "item.completed",
                    "item": { "id": "c2", "type": "command_execution", "aggregated_output": "boom", "exit_code": 1 }
                })
                .to_string(),
            );
            let AgentStreamEvent::ToolResult { is_error, .. } = &events[0] else {
                panic!()
            };
            assert!(is_error);
        }

        /// Absent an exit code, `status: "failed"` is the fallback signal —
        /// codex's own `resume` path reports failures this way.
        #[test]
        fn status_failed_is_an_error_when_no_exit_code_is_present() {
            let (_, events) = run(
                &json!({
                    "type": "item.completed",
                    "item": { "id": "c3", "type": "command_execution", "aggregated_output": "x", "status": "failed" }
                })
                .to_string(),
            );
            let AgentStreamEvent::ToolResult { is_error, .. } = &events[0] else {
                panic!()
            };
            assert!(is_error);
        }

        #[test]
        fn an_agent_message_completing_is_forwarded_as_text() {
            let (_, events) = run(
                &json!({ "type": "item.completed", "item": { "id": "m1", "type": "agent_message", "text": "hello there" } })
                    .to_string(),
            );
            assert_eq!(
                events,
                vec![AgentStreamEvent::Text {
                    text: "hello there".to_string()
                }]
            );
        }

        /// Only `item.completed` renders an agent message — `item.started`
        /// carries the same shape but must not double-emit the text.
        #[test]
        fn an_agent_message_starting_is_silent() {
            let (_, events) = run(
                &json!({ "type": "item.started", "item": { "id": "m1", "type": "agent_message", "text": "hello there" } })
                    .to_string(),
            );
            assert!(events.is_empty());
        }

        #[test]
        fn an_empty_agent_message_is_not_emitted() {
            let (_, events) = run(
                &json!({ "type": "item.completed", "item": { "id": "m2", "type": "agent_message", "text": "" } }).to_string(),
            );
            assert!(events.is_empty());
        }

        #[test]
        fn an_item_missing_an_id_is_silent() {
            let (_, events) = run(
                &json!({ "type": "item.started", "item": { "type": "command_execution" } })
                    .to_string(),
            );
            assert!(events.is_empty());
        }

        #[test]
        fn turn_completed_reports_done_with_no_stop_reason() {
            let (_, events) = run(&json!({ "type": "turn.completed" }).to_string());
            assert_eq!(events, vec![AgentStreamEvent::Done { stop_reason: None }]);
        }

        #[test]
        fn an_unknown_type_is_silent() {
            let (session, events) = run(&json!({ "type": "something_else" }).to_string());
            assert_eq!(session, None);
            assert!(events.is_empty());
        }

        #[test]
        fn malformed_json_is_silent() {
            let (session, events) = run("{not json");
            assert_eq!(session, None);
            assert!(events.is_empty());
        }
    }

    /// Every case pinned against real reference output.
    mod is_dangerous_bash_command_matches_the_reference {
        use super::*;

        #[test]
        fn safe_commands_are_not_dangerous() {
            for safe in [
                "ls -la",
                "rm file.txt",
                "git reset --soft HEAD~1",
                "",
                "   ",
            ] {
                assert!(
                    !is_dangerous_bash_command(Some(safe)),
                    "{safe:?} should be safe"
                );
            }
        }

        #[test]
        fn destructive_commands_are_dangerous() {
            for dangerous in [
                "rm -rf /tmp/x",
                "rm -fr node_modules",
                "git reset --hard origin/main",
                "git clean -fd",
                "git push --force origin main",
                "git push -f origin main",
                "git push --force-with-lease",
                "git branch -D feature",
                "echo hi > file.txt",
                "echo hi >> file.txt",
            ] {
                assert!(
                    is_dangerous_bash_command(Some(dangerous)),
                    "{dangerous:?} should be dangerous"
                );
            }
        }

        /// Absence of proof is not proof of safety: a missing command name
        /// denies just as a matched pattern does.
        #[test]
        fn a_missing_command_is_dangerous() {
            assert!(is_dangerous_bash_command(None));
        }
    }

    mod providers {
        use super::*;

        #[test]
        fn approvals_are_claude_only() {
            assert!(approvals_enabled(&claude_provider(), "default"));
            assert!(!approvals_enabled(&claude_provider(), "bypassPermissions"));
            assert!(!approvals_enabled(&codex_provider(), "default"));
        }

        #[test]
        fn resolve_chat_provider_prefers_an_explicit_choice() {
            let resolved = resolve_chat_provider("codex", Some("claude"));
            assert_eq!(resolved.id, ProviderId::Claude);
        }

        #[test]
        fn resolve_chat_provider_falls_back_to_detection_then_claude() {
            assert_eq!(resolve_chat_provider("codex", None).id, ProviderId::Codex);
            assert_eq!(
                resolve_chat_provider("unknown", None).id,
                ProviderId::Claude
            );
        }

        #[test]
        fn provider_by_id_rejects_unknown_ids() {
            assert!(provider_by_id(Some("gemini")).is_none());
            assert!(provider_by_id(None).is_none());
        }
    }

    mod approval_settings_shape {
        use super::*;

        #[test]
        fn names_the_hook_command_and_gates_the_expected_tools() {
            let settings: serde_json::Value = serde_json::from_str(&approval_settings()).unwrap();
            assert_eq!(
                settings["permissions"]["allow"],
                serde_json::json!(["mcp__nomoreide"])
            );
            let matcher = &settings["hooks"]["PreToolUse"][0]["matcher"];
            assert_eq!(matcher, &serde_json::json!(GATED_TOOLS));
            let command = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap();
            assert!(command.starts_with("node "));
            assert!(command.contains("approval-hook.cjs"));
        }

        #[test]
        fn is_cached_across_calls() {
            assert_eq!(approval_settings(), approval_settings());
        }
    }

    mod run_end_to_end {
        use super::*;
        use crate::approval_broker::ApprovalBroker;
        use std::time::Duration;

        /// A stub "claude" that emits an init event, one gated tool call
        /// awaiting approval, then exits after the decision unblocks it.
        ///
        /// Real Claude Code blocks on its own hook subprocess; this stub
        /// mimics that shape without needing a real installed CLI: it emits
        /// the tool_use line, then polls a marker file the test writes only
        /// after resolving the approval, so the run loop's approval bridging
        /// is exercised against a real spawned child.
        fn write_stub_claude(
            dir: &std::path::Path,
            marker: &std::path::Path,
        ) -> std::path::PathBuf {
            let path = dir.join("claude");
            let script = format!(
                r#"#!/bin/sh
echo '{{"type":"system","subtype":"init","session_id":"stub-session"}}'
echo '{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"t1","name":"Bash","input":{{"command":"ls"}}}}]}}}}'
while [ ! -f "{marker}" ]; do sleep 0.05; done
echo '{{"type":"result","subtype":"success"}}'
"#,
                marker = marker.display()
            );
            std::fs::write(&path, script).unwrap();
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                perms.set_mode(0o755);
            }
            std::fs::set_permissions(&path, perms).unwrap();
            path
        }

        #[tokio::test]
        async fn a_gated_run_opens_and_closes_its_approval_channel() {
            let dir = std::env::temp_dir()
                .join(format!("nmi-agent-runtime-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let marker = dir.join("resolved");
            let bin = write_stub_claude(&dir, &marker);

            let provider = AgentChatProvider {
                id: ProviderId::Claude,
                label: "Claude Code",
                command_name: "claude",
                bin: bin.to_string_lossy().into_owned(),
                install_hint: "n/a",
                intro: "n/a",
            };

            let broker = ApprovalBroker::new();
            let (events_tx, mut events_rx) = mpsc::unbounded_channel();

            let running = tokio::spawn({
                let broker = broker.clone();
                let events_tx = events_tx.clone();
                async move {
                    run(
                        dir.to_str().unwrap(),
                        &provider,
                        RunOptions {
                            message: "hello",
                            resume_session_id: None,
                            permission_mode: "default",
                            codex_approval_policy: "never",
                            approval: Some(Approval {
                                broker,
                                url: "http://127.0.0.1:0/unused".to_string(),
                                auto_approve: false,
                            }),
                        },
                        events_tx,
                    )
                    .await;
                }
            });

            // Drain events until the run opens its channel (the session event),
            // confirming the broker really did register this run under the
            // stub's session id before we try to resolve anything against it.
            let mut opened = false;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while tokio::time::Instant::now() < deadline {
                match tokio::time::timeout(Duration::from_millis(200), events_rx.recv()).await {
                    Ok(Some(AgentStreamEvent::Session { session_id })) => {
                        assert_eq!(session_id, "stub-session");
                        opened = true;
                    }
                    Ok(Some(_)) => {}
                    _ => {
                        if broker.has_run("stub-session") {
                            break;
                        }
                    }
                }
                if broker.has_run("stub-session") {
                    break;
                }
            }
            assert!(
                opened,
                "the session event must arrive before the channel opens"
            );
            assert!(
                broker.has_run("stub-session"),
                "the broker must have an open run for the stub's session id"
            );

            // The stub does not perform the hook's own HTTP round trip — it
            // exits once this marker exists, standing in for "the approval was
            // delivered" so the test can assert on the broker's bookkeeping
            // (open/close) without a real hook process in the loop.
            std::fs::write(&marker, "").unwrap();

            tokio::time::timeout(Duration::from_secs(10), running)
                .await
                .expect("the run must finish once the stub is unblocked")
                .unwrap();

            assert!(
                !broker.has_run("stub-session"),
                "close_run must fire once the child exits"
            );
        }
    }
}
