import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalBroker } from "./approval-broker.js";

/**
 * In-dashboard AI agent backed by the real local agent CLI. NoMoreIDE selects
 * Claude Code or Codex from the same startup-agent detection used by /agent,
 * then drives that CLI in a machine-readable headless mode rather than calling
 * a vendor API directly.
 *
 * Conversation continuity uses the selected CLI's own session store: the first
 * turn returns a session id, which the client sends back as `resumeSessionId` on
 * the next turn. The server holds no transcript state.
 *
 * Tool permissions: unless NOMOREIDE_AGENT_PERMISSION_MODE=bypassPermissions,
 * the agent runs in `default` mode with a PreToolUse hook on mutating tools.
 * The hook blocks and asks the dock (via ApprovalBroker) for an Allow/Deny.
 */

const CLAUDE_BIN = process.env.NOMOREIDE_CLAUDE_BIN || "claude";
const CODEX_BIN = process.env.NOMOREIDE_CODEX_BIN || "codex";
/** "bypassPermissions" runs fully autonomous (no approval prompts). */
const PERMISSION_MODE = process.env.NOMOREIDE_AGENT_PERMISSION_MODE || "default";
const CODEX_APPROVAL_POLICY = process.env.NOMOREIDE_CODEX_APPROVAL_POLICY || "never";
/** Tools that trigger an approval prompt (mutating / side-effecting ones). */
const GATED_TOOLS = "Bash|Edit|Write|MultiEdit|NotebookEdit";
/** Truncate tool-result previews shown in the dock. */
const PREVIEW_LIMIT = 400;

export type AgentChatProviderId = "claude" | "codex";
export type DetectedAgentName = "claude-code" | "codex" | "gemini" | "unknown";

export interface AgentChatProvider {
  id: AgentChatProviderId;
  label: string;
  commandName: string;
  bin: string;
  installHint: string;
  intro: string;
}

export interface AgentInvocation {
  bin: string;
  args: string[];
}

export const CLAUDE_PROVIDER: AgentChatProvider = {
  id: "claude",
  label: "Claude Code",
  commandName: "claude",
  bin: CLAUDE_BIN,
  installHint:
    "Install Claude Code (and run `claude login`) so it is on NoMoreIDE's PATH, then reload.",
  intro:
    "This is real Claude Code, running in your workspace with full tools - e.g. \"restart the api and tail its logs\", \"what changed in git and why?\", \"fix the failing test\".",
};

export const CODEX_PROVIDER: AgentChatProvider = {
  id: "codex",
  label: "Codex",
  commandName: "codex",
  bin: CODEX_BIN,
  installHint:
    "Install Codex CLI (and run `codex login`) so it is on NoMoreIDE's PATH, then reload.",
  intro:
    "This is real Codex CLI, running in your workspace with full tools - e.g. \"restart the api and tail its logs\", \"what changed in git and why?\", \"fix the failing test\".",
};

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
  /** Working directory the agent session runs in (the workspace root). */
  cwd: string;
  /** CLI provider selected from the agent that started NoMoreIDE. */
  provider?: AgentChatProvider;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  /** When present, gated tools prompt the dock for approval via this broker. */
  approval?: { broker: ApprovalBroker; url: string };
  /**
   * Scoped auto-approve for this turn (a workflow step the user already
   * consented to via a gate). The approval hook then auto-allows Edit/Write and
   * non-footgun Bash without prompting — but irreversible footguns (`reset
   * --hard`, force-push, `branch -D`, `rm -rf`, chained/redirected shell) still
   * fall through to the dock. Has no effect unless approvals are gating.
   */
  autoApprove?: boolean;
}

const availabilityProbes = new Map<AgentChatProviderId, Promise<boolean>>();

/** Every selectable chat provider, in display order. */
export const CHAT_PROVIDERS: readonly AgentChatProvider[] = [CLAUDE_PROVIDER, CODEX_PROVIDER];

/** Look up a provider by its id; undefined for unknown ids. */
export function providerById(id: string | undefined): AgentChatProvider | undefined {
  return CHAT_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Pick the in-dock chat provider. An explicit user choice (`preferredId`, saved
 * in config) wins; otherwise fall back to the startup-agent detection that the
 * MCP-launched flow relies on; otherwise Claude.
 */
export function resolveChatProvider(
  detectedName: DetectedAgentName,
  preferredId?: string,
): AgentChatProvider {
  return (
    providerById(preferredId) ??
    (detectedName === "codex" ? CODEX_PROVIDER : CLAUDE_PROVIDER)
  );
}

export function publicProviderInfo(provider: AgentChatProvider) {
  return {
    id: provider.id,
    label: provider.label,
    commandName: provider.commandName,
    installHint: provider.installHint,
    intro: provider.intro,
  };
}

/** True when the selected agent CLI is installed and runnable. Memoized. */
export function isAgentAvailable(
  provider: AgentChatProvider = CLAUDE_PROVIDER,
): Promise<boolean> {
  const existing = availabilityProbes.get(provider.id);
  if (existing) return existing;

  const probe = new Promise<boolean>((resolve) => {
    const child = spawn(provider.bin, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
  }).catch(() => false);
  availabilityProbes.set(provider.id, probe);
  return probe;
}

/** Whether tool calls are gated behind dock approval (vs. fully autonomous). */
export function approvalsEnabled(provider: AgentChatProvider = CLAUDE_PROVIDER): boolean {
  return provider.id === "claude" && PERMISSION_MODE !== "bypassPermissions";
}

export function buildAgentInvocation(
  provider: AgentChatProvider,
  message: string,
  resumeSessionId: string | undefined,
  gating: boolean,
): AgentInvocation {
  if (provider.id === "codex") {
    const args = ["-a", CODEX_APPROVAL_POLICY, "exec"];
    if (resumeSessionId) {
      args.push("resume", "--json", "--skip-git-repo-check", resumeSessionId, message);
    } else {
      args.push("--json", "--skip-git-repo-check", message);
    }
    return { bin: provider.bin, args };
  }

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
  return { bin: provider.bin, args };
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
    const { signal, approval, autoApprove } = options;
    const provider = this.deps.provider ?? CLAUDE_PROVIDER;
    const gating = Boolean(approval) && approvalsEnabled(provider);
    const invocation = buildAgentInvocation(provider, message, resumeSessionId, gating);

    const env = gating && approval
      ? {
          ...process.env,
          NOMOREIDE_APPROVAL_URL: approval.url,
          // Scoped auto-approve for a consented workflow step (footguns still prompt).
          ...(autoApprove ? { NOMOREIDE_AUTO_APPROVE: "1" } : {}),
        }
      : process.env;

    await new Promise<void>((resolve) => {
      const child = spawn(invocation.bin, invocation.args, {
        cwd: this.deps.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
        const sessionId =
          provider.id === "codex"
            ? handleCodexLine(line, toolNames, onEvent)
            : handleClaudeLine(line, toolNames, onEvent);
        if (sessionId && gating && approval && !openedSession) {
          openedSession = sessionId;
          approval.broker.openRun(sessionId, (request) =>
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
              ? `Could not run "${provider.bin}". ${provider.installHint}`
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
            message: stderr.trim() || `${provider.label} exited with code ${code}.`,
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
export function handleClaudeLine(
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

/** Parse one JSONL event from `codex exec --json`. */
export function handleCodexLine(
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

  if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
    onEvent({ type: "session", sessionId: obj.thread_id });
    return obj.thread_id;
  }

  if (obj.type === "item.started" || obj.type === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (!item || typeof item.id !== "string" || typeof item.type !== "string") {
      return undefined;
    }

    if (item.type === "command_execution") {
      const name = "command";
      toolNames.set(item.id, name);
      const command = typeof item.command === "string" ? item.command : "";
      if (obj.type === "item.started") {
        onEvent({ type: "tool_use", id: item.id, name, input: { command } });
        return undefined;
      }
      onEvent({
        type: "tool_result",
        id: item.id,
        name,
        preview: previewOf(item.aggregated_output),
        isError:
          typeof item.exit_code === "number"
            ? item.exit_code !== 0
            : item.status === "failed",
      });
      return undefined;
    }

    if (item.type === "agent_message" && obj.type === "item.completed") {
      const text = typeof item.text === "string" ? item.text : "";
      if (text) onEvent({ type: "text", text });
      return undefined;
    }
  }

  if (obj.type === "turn.completed") {
    onEvent({ type: "done", stopReason: null });
  }

  return undefined;
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

/**
 * Irreversible / history-rewriting shell that must keep a human in the loop even
 * inside an auto-approved workflow step. Exported so it's unit-testable; the
 * approval hook runs this exact function (serialized via `toString()` into
 * {@link HOOK_SOURCE}). Unknown shapes are treated as risky.
 */
export function isDangerousBashCommand(cmd: unknown): boolean {
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

let hookPath: string | undefined;
let settingsJson: string | undefined;

/** Inline `--settings` JSON installing the PreToolUse approval hook. Cached. */
function approvalSettings(): string {
  if (!settingsJson) {
    const command = `node ${JSON.stringify(ensureHookScript())}`;
    settingsJson = JSON.stringify({
      // NoMoreIDE's own MCP tools are read-safe / scoped to registered services,
      // so auto-allow them. Claude Code has no wildcard for the tool portion of
      // an MCP rule; the bare server prefix `mcp__nomoreide` allows every tool
      // from that server. Everything else (Bash/Edit/Write/Read/...) is left to
      // the PreToolUse hook below — onboarding leans on the structured profile
      // from `nomoreide_onboard_repo` instead of crawling the repo, so the agent
      // shouldn't need Read/Glob/Grep at all.
      permissions: { allow: ["mcp__nomoreide"] },
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
  if (/[;&|<>$()\\\`]/.test(c)) return false;
  return /^(echo|pwd|whoami|true|date|ls|node|npm (install|ci|--version|-v)|pnpm (install|--version|-v)|yarn( install| --version| -v)?|bun (install|--version|-v)|pip3? install)\\b/.test(c);
}
${isDangerousBashCommand.toString()}
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
