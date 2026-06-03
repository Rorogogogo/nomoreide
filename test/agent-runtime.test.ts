import { afterEach, describe, expect, test } from "vitest";
import {
  buildAgentInvocation,
  handleCodexLine,
  isDangerousBashCommand,
  resolveChatProvider,
  type AgentStreamEvent,
} from "../src/core/agent-runtime.js";
import { detectAgent } from "../src/web/agent-info.js";

const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
const ORIGINAL_CODEX_SANDBOX = process.env.CODEX_SANDBOX;
const ORIGINAL_CODEX_CLI = process.env.CODEX_CLI;
const ORIGINAL_CLAUDECODE = process.env.CLAUDECODE;
const ORIGINAL_CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT;
const ORIGINAL_CLAUDE_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

afterEach(() => {
  restoreEnv("CODEX_HOME", ORIGINAL_CODEX_HOME);
  restoreEnv("CODEX_SANDBOX", ORIGINAL_CODEX_SANDBOX);
  restoreEnv("CODEX_CLI", ORIGINAL_CODEX_CLI);
  restoreEnv("CLAUDECODE", ORIGINAL_CLAUDECODE);
  restoreEnv("CLAUDE_CODE_ENTRYPOINT", ORIGINAL_CLAUDE_CODE_ENTRYPOINT);
  restoreEnv("CLAUDE_PROJECT_DIR", ORIGINAL_CLAUDE_PROJECT_DIR);
});

describe("agent chat provider selection", () => {
  test("detects Codex startup signals used by the /agent page", async () => {
    process.env.CODEX_HOME = "/tmp/codex-home";
    delete process.env.CODEX_SANDBOX;
    delete process.env.CODEX_CLI;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PROJECT_DIR;

    await expect(detectAgent()).resolves.toMatchObject({
      name: "codex",
      label: "OpenAI Codex CLI",
      signals: ["CODEX_HOME set"],
    });
  });

  test("uses Codex when NoMoreIDE was started by Codex", () => {
    expect(resolveChatProvider("codex")).toMatchObject({
      id: "codex",
      bin: "codex",
      label: "Codex",
    });
  });

  test("keeps Claude as the fallback for Claude and unknown sessions", () => {
    expect(resolveChatProvider("claude-code").id).toBe("claude");
    expect(resolveChatProvider("unknown").id).toBe("claude");
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("agent runtime invocation", () => {
  test("builds a fresh Codex JSON invocation", () => {
    const invocation = buildAgentInvocation(
      resolveChatProvider("codex"),
      "explain this repo",
      undefined,
      false,
    );

    expect(invocation).toMatchObject({
      bin: "codex",
      args: ["-a", "never", "exec", "--json", "--skip-git-repo-check", "explain this repo"],
    });
  });

  test("builds a Codex resume JSON invocation", () => {
    const invocation = buildAgentInvocation(
      resolveChatProvider("codex"),
      "continue",
      "019e5f7a-7a59-7993-a1c0-8105c51135f5",
      false,
    );

    expect(invocation).toMatchObject({
      bin: "codex",
      args: [
        "-a",
        "never",
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "019e5f7a-7a59-7993-a1c0-8105c51135f5",
        "continue",
      ],
    });
  });
});

describe("Codex JSONL parsing", () => {
  test("emits session, command, message, and done events", () => {
    const toolNames = new Map<string, string>();
    const events: AgentStreamEvent[] = [];

    handleCodexLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      toolNames,
      (event) => events.push(event),
    );
    handleCodexLine(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "npm test",
          status: "in_progress",
        },
      }),
      toolNames,
      (event) => events.push(event),
    );
    handleCodexLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "ok",
          exit_code: 0,
          status: "completed",
        },
      }),
      toolNames,
      (event) => events.push(event),
    );
    handleCodexLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: "Done.",
        },
      }),
      toolNames,
      (event) => events.push(event),
    );
    handleCodexLine(JSON.stringify({ type: "turn.completed" }), toolNames, (event) =>
      events.push(event),
    );

    expect(events).toEqual([
      { type: "session", sessionId: "thread-1" },
      { type: "tool_use", id: "item_0", name: "command", input: { command: "npm test" } },
      { type: "tool_result", id: "item_0", name: "command", preview: "ok", isError: false },
      { type: "text", text: "Done." },
      { type: "done", stopReason: null },
    ]);
  });
});

describe("auto-approve footgun policy (isDangerousBashCommand)", () => {
  test("keeps irreversible / history-rewriting shell behind the dock", () => {
    for (const cmd of [
      "rm -rf node_modules",
      "git reset --hard HEAD~1",
      "git clean -fd",
      "git push --force",
      "git push -f origin main",
      "git branch -D feature",
      "echo secret > .env",
    ]) {
      expect(isDangerousBashCommand(cmd), cmd).toBe(true);
    }
  });

  test("allows ordinary workflow shell to run unattended", () => {
    for (const cmd of [
      "git status",
      "git add -A",
      'git commit -m "feat: add workflows"',
      "git push",
      "git pull --rebase",
      "npm test",
    ]) {
      expect(isDangerousBashCommand(cmd), cmd).toBe(false);
    }
  });

  test("treats a non-string (unknown shape) as risky", () => {
    expect(isDangerousBashCommand(undefined)).toBe(true);
    expect(isDangerousBashCommand({ not: "a string" })).toBe(true);
  });
});
