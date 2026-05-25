import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalBroker } from "./approval-broker.js";

/**
 * In-dashboard AI agent backed by the real Claude Code CLI. We drive the
 * installed `claude` binary in headless streaming mode (`--output-format
 * stream-json`) rather than the Anthropic API directly, so the dock gets the
 * full Claude Code agent — its tools, this project's .mcp.json / CLAUDE.md, and
 * the user's existing Claude Code login (no separate API key).
 *
 * Conversation continuity uses Claude Code's own session store: the first turn
 * returns a `session_id`, which the client sends back as `resumeSessionId` on
 * the next turn (`--resume`). The server holds no transcript state.
 *
 * Tool permissions: unless NOMOREIDE_AGENT_PERMISSION_MODE=bypassPermissions,
 * the agent runs in `default` mode with a PreToolUse hook on mutating tools.
 * The hook blocks and asks the dock (via ApprovalBroker) for an Allow/Deny.
 */

const CLAUDE_BIN = process.env.NOMOREIDE_CLAUDE_BIN || "claude";
/** "bypassPermissions" runs fully autonomous (no approval prompts). */
const PERMISSION_MODE = process.env.NOMOREIDE_AGENT_PERMISSION_MODE || "default";
/** Tools that trigger an approval prompt (mutating / side-effecting ones). */
const GATED_TOOLS = "Bash|Edit|Write|MultiEdit|NotebookEdit";
/** Truncate tool-result previews shown in the dock. */
const PREVIEW_LIMIT = 400;

/** Streamed back to the route, which forwards each as an SSE event. */
export type AgentStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; preview: string; isError: boolean }
  | { type: "approval_request"; requestId: string; name: string; input: unknown }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; message: string };

export interface AgentRuntimeDeps {
  /** Working directory the Claude Code session runs in (the workspace root). */
  cwd: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  /** When present, gated tools prompt the dock for approval via this broker. */
  approval?: { broker: ApprovalBroker; url: string };
}

let availabilityProbe: Promise<boolean> | null = null;

/** True when the `claude` CLI is installed and runnable. Memoized. */
export function isAgentAvailable(): Promise<boolean> {
  if (!availabilityProbe) {
    availabilityProbe = new Promise<boolean>((resolve) => {
      const child = spawn(CLAUDE_BIN, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    }).catch(() => false);
  }
  return availabilityProbe;
}

/** Whether tool calls are gated behind dock approval (vs. fully autonomous). */
export function approvalsEnabled(): boolean {
  return PERMISSION_MODE !== "bypassPermissions";
}

export class AgentRuntime {
  constructor(private readonly deps: AgentRuntimeDeps) {}

  /**
   * Run one user turn. Streams events until the CLI exits. `resumeSessionId`
   * continues a prior Claude Code session; omit it to start a fresh one.
   */
  async run(
    message: string,
    resumeSessionId: string | undefined,
    onEvent: (event: AgentStreamEvent) => void,
    options: AgentRunOptions = {},
  ): Promise<void> {
    const { signal, approval } = options;
    const gating = Boolean(approval) && approvalsEnabled();

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      gating ? "default" : PERMISSION_MODE,
    ];
    if (gating) {
      args.push("--settings", approvalSettings());
    }
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push(message);

    const env = gating
      ? { ...process.env, NOMOREIDE_APPROVAL_URL: approval!.url }
      : process.env;

    await new Promise<void>((resolve) => {
      const child = spawn(CLAUDE_BIN, args, { cwd: this.deps.cwd, env });
      const toolNames = new Map<string, string>();
      let stdout = "";
      let stderr = "";
      let finished = false;
      let openedSession: string | undefined;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (openedSession) approval?.broker.closeRun(openedSession);
        resolve();
      };

      // Bridge the broker's approval requests onto the SSE stream the moment
      // we learn this run's session id.
      const onLine = (line: string) => {
        const sessionId = handleLine(line, toolNames, onEvent);
        if (sessionId && gating && !openedSession) {
          openedSession = sessionId;
          approval!.broker.openRun(sessionId, (request) =>
            onEvent({
              type: "approval_request",
              requestId: request.requestId,
              name: request.name,
              input: request.input,
            }),
          );
        }
      };

      if (signal) {
        if (signal.aborted) child.kill();
        else signal.addEventListener("abort", () => child.kill(), { once: true });
      }

      child.on("error", (error) => {
        onEvent({
          type: "error",
          message:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? `Could not run "${CLAUDE_BIN}". Install Claude Code or set NOMOREIDE_CLAUDE_BIN.`
              : error.message,
        });
        finish();
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        let newline = stdout.indexOf("\n");
        while (newline !== -1) {
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (line) onLine(line);
          newline = stdout.indexOf("\n");
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("close", (code) => {
        if (signal?.aborted) return finish();
        const leftover = stdout.trim();
        if (leftover) onLine(leftover);
        if (code !== 0) {
          onEvent({
            type: "error",
            message: stderr.trim() || `Claude Code exited with code ${code}.`,
          });
        }
        finish();
      });
    });
  }
}

/**
 * Parse one NDJSON line from Claude Code's stream-json output, emitting the
 * relevant dock events. Returns the session id when this line is the init event.
 */
function handleLine(
  line: string,
  toolNames: Map<string, string>,
  onEvent: (event: AgentStreamEvent) => void,
): string | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }

  switch (obj.type) {
    case "system": {
      if (obj.subtype === "init" && typeof obj.session_id === "string") {
        onEvent({ type: "session", sessionId: obj.session_id });
        return obj.session_id;
      }
      return undefined;
    }
    case "stream_event": {
      // Token-level text deltas (from --include-partial-messages).
      const event = obj.event as { type?: string; delta?: { type?: string; text?: string } };
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        onEvent({ type: "text", text: event.delta.text ?? "" });
      }
      return undefined;
    }
    case "assistant": {
      for (const block of messageContent(obj.message)) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          toolNames.set(block.id, String(block.name));
          onEvent({ type: "tool_use", id: block.id, name: String(block.name), input: block.input });
        }
      }
      return undefined;
    }
    case "user": {
      for (const block of messageContent(obj.message)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          onEvent({
            type: "tool_result",
            id: block.tool_use_id,
            name: toolNames.get(block.tool_use_id) ?? "tool",
            preview: previewOf(block.content),
            isError: Boolean(block.is_error),
          });
        }
      }
      return undefined;
    }
    case "result": {
      onEvent({ type: "done", stopReason: typeof obj.subtype === "string" ? obj.subtype : null });
      return undefined;
    }
    default:
      return undefined;
  }
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: unknown;
  input?: unknown;
  tool_use_id?: string;
  is_error?: unknown;
  content?: unknown;
}

function messageContent(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown })?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function previewOf(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) =>
        typeof block === "string"
          ? block
          : typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : "",
      )
      .join(" ");
  } else {
    text = "";
  }
  text = text.trim();
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

let hookPath: string | undefined;
let settingsJson: string | undefined;

/** Inline `--settings` JSON installing the PreToolUse approval hook. Cached. */
function approvalSettings(): string {
  if (!settingsJson) {
    const command = `node ${JSON.stringify(ensureHookScript())}`;
    settingsJson = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: GATED_TOOLS, hooks: [{ type: "command", command }] }],
      },
    });
  }
  return settingsJson;
}

/**
 * Write the approval-hook script to a temp file once, runnable by plain `node`
 * in both dev (tsx) and built modes. It POSTs the pending tool call to the web
 * server and blocks until the user's decision returns, then prints the
 * PreToolUse permission decision Claude Code expects.
 */
function ensureHookScript(): string {
  if (hookPath) return hookPath;
  const dir = mkdtempSync(join(tmpdir(), "nomoreide-agent-"));
  hookPath = join(dir, "approval-hook.cjs");
  writeFileSync(hookPath, HOOK_SOURCE, "utf8");
  return hookPath;
}

const HOOK_SOURCE = `"use strict";
const http = require("http");
const { randomUUID } = require("crypto");
let body = "";
process.stdin.on("data", (d) => (body += d));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(body); } catch {}
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
`;
