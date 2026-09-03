/**
 * Probe: run the reference's pure agent-runtime functions directly (not read
 * for behaviour) and print their outputs for known inputs, so the Rust port
 * can be asserted against real reference output rather than a reading of the
 * TypeScript.
 */
import {
  buildAgentInvocation,
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  handleClaudeLine,
  handleCodexLine,
  isDangerousBashCommand,
} from "../../src/core/agent-runtime.js";
import type { AgentStreamEvent } from "../../src/core/agent-runtime.js";
import { inspect } from "node:util";

function events(events: AgentStreamEvent[]) {
  return events.map((e) => inspect(e, { depth: null, breakLength: 300 })).join("\n    ");
}

console.log("=== buildAgentInvocation ===");
const invocationCases: Array<[string, () => unknown]> = [
  ["claude/fresh/ungated", () => buildAgentInvocation(CLAUDE_PROVIDER, "hello", undefined, false)],
  ["claude/fresh/gated", () => buildAgentInvocation(CLAUDE_PROVIDER, "hello", undefined, true)],
  ["claude/resume/ungated", () => buildAgentInvocation(CLAUDE_PROVIDER, "again", "sess-1", false)],
  ["claude/resume/gated", () => buildAgentInvocation(CLAUDE_PROVIDER, "again", "sess-1", true)],
  ["claude/empty-message", () => buildAgentInvocation(CLAUDE_PROVIDER, "", undefined, false)],
  ["codex/fresh", () => buildAgentInvocation(CODEX_PROVIDER, "hello", undefined, false)],
  ["codex/resume", () => buildAgentInvocation(CODEX_PROVIDER, "again", "thread-1", false)],
  ["codex/gated-is-still-ungated-arg-shape", () => buildAgentInvocation(CODEX_PROVIDER, "hi", undefined, true)],
];
for (const [name, run] of invocationCases) {
  const result = run() as { bin: string; args: string[] };
  // Elide the --settings JSON, which embeds a throwaway temp path.
  const args = result.args.map((a) => (a.includes("hookSpecificOutput") || a.includes("PreToolUse") ? "<settings-json>" : a));
  console.log(`${name}: bin=${result.bin} args=${JSON.stringify(args)}`);
}

console.log("\n=== handleClaudeLine ===");
const claudeLines: Array<[string, string]> = [
  ["init", JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" })],
  ["init-no-session-id", JSON.stringify({ type: "system", subtype: "init" })],
  ["other-system-subtype", JSON.stringify({ type: "system", subtype: "other" })],
  [
    "text-delta",
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    }),
  ],
  [
    "non-text-delta",
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta" } },
    }),
  ],
  [
    "tool-use",
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    }),
  ],
  [
    "tool-use-numeric-name",
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t2", name: 7, input: {} }] },
    }),
  ],
  [
    "tool-result-string-content",
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "output here", is_error: false }] },
    }),
  ],
  [
    "tool-result-array-content",
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "block one" }, "raw string", { type: "text" }],
            is_error: true,
          },
        ],
      },
    }),
  ],
  [
    "tool-result-unknown-id",
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "never-seen", content: "x" }] },
    }),
  ],
  [
    "tool-result-long-preview",
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(500) }] },
    }),
  ],
  ["result-with-subtype", JSON.stringify({ type: "result", subtype: "success" })],
  ["result-no-subtype", JSON.stringify({ type: "result" })],
  ["unknown-type", JSON.stringify({ type: "something_else" })],
  ["malformed", "{not json"],
];
const claudeToolNames = new Map<string, string>();
for (const [name, line] of claudeLines) {
  const seen: AgentStreamEvent[] = [];
  const sessionId = handleClaudeLine(line, claudeToolNames, (e) => seen.push(e));
  console.log(`${name}: sessionId=${JSON.stringify(sessionId)}\n    ${events(seen)}`);
}

console.log("\n=== handleCodexLine ===");
const codexLines: Array<[string, string]> = [
  ["thread-started", JSON.stringify({ type: "thread.started", thread_id: "th-1" })],
  ["thread-started-no-id", JSON.stringify({ type: "thread.started" })],
  [
    "command-started",
    JSON.stringify({ type: "item.started", item: { id: "c1", type: "command_execution", command: "ls -la" } }),
  ],
  [
    "command-completed-success",
    JSON.stringify({
      type: "item.completed",
      item: { id: "c1", type: "command_execution", aggregated_output: "done", exit_code: 0 },
    }),
  ],
  [
    "command-completed-nonzero",
    JSON.stringify({
      type: "item.completed",
      item: { id: "c2", type: "command_execution", aggregated_output: "boom", exit_code: 1 },
    }),
  ],
  [
    "command-completed-status-failed-no-exit-code",
    JSON.stringify({
      type: "item.completed",
      item: { id: "c3", type: "command_execution", aggregated_output: "x", status: "failed" },
    }),
  ],
  [
    "agent-message-completed",
    JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "hello there" } }),
  ],
  [
    "agent-message-started-ignored",
    JSON.stringify({ type: "item.started", item: { id: "m1", type: "agent_message", text: "hello there" } }),
  ],
  ["agent-message-empty-text", JSON.stringify({ type: "item.completed", item: { id: "m2", type: "agent_message", text: "" } })],
  ["item-missing-id", JSON.stringify({ type: "item.started", item: { type: "command_execution" } })],
  ["turn-completed", JSON.stringify({ type: "turn.completed" })],
  ["unknown-type", JSON.stringify({ type: "something_else" })],
  ["malformed", "{not json"],
];
const codexToolNames = new Map<string, string>();
for (const [name, line] of codexLines) {
  const seen: AgentStreamEvent[] = [];
  const sessionId = handleCodexLine(line, codexToolNames, (e) => seen.push(e));
  console.log(`${name}: sessionId=${JSON.stringify(sessionId)}\n    ${events(seen)}`);
}

console.log("\n=== isDangerousBashCommand ===");
const dangerCases: Array<[string, unknown]> = [
  ["plain-ls", "ls -la"],
  ["rm-rf", "rm -rf /tmp/x"],
  ["rm-fr-order", "rm -fr node_modules"],
  ["rm-no-f", "rm file.txt"],
  ["git-reset-hard", "git reset --hard origin/main"],
  ["git-reset-soft", "git reset --soft HEAD~1"],
  ["git-clean-f", "git clean -fd"],
  ["git-push-force", "git push --force origin main"],
  ["git-push-force-short", "git push -f origin main"],
  ["git-push-force-with-lease", "git push --force-with-lease"],
  ["git-branch-delete", "git branch -D feature"],
  ["redirect", "echo hi > file.txt"],
  ["append-redirect", "echo hi >> file.txt"],
  ["non-string", 42],
  ["null", null],
  ["undefined", undefined],
  ["empty-string", ""],
  ["whitespace-only", "   "],
];
for (const [name, cmd] of dangerCases) {
  console.log(`${name}: ${isDangerousBashCommand(cmd)}`);
}
