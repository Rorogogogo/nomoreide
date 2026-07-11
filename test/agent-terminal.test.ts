import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadInvocationBuilder(claudeBin = "", codexBin = "") {
  vi.stubEnv("NOMOREIDE_CLAUDE_BIN", claudeBin);
  vi.stubEnv("NOMOREIDE_CODEX_BIN", codexBin);
  vi.resetModules();
  return (await import("../src/core/agent-terminal.js")).buildInteractiveAgentInvocation;
}

async function loadAgentTerminal() {
  return import("../src/web/client/src/features/agent/terminal/agent-terminal-input.js");
}

describe("interactive agent terminal invocation", () => {
  test("uses configured Claude and Codex binaries", async () => {
    const buildInvocation = await loadInvocationBuilder("/custom/claude", "/custom/codex");

    expect(buildInvocation("claude", "Fix it").shell).toBe("/custom/claude");
    expect(buildInvocation("codex", "Review it").shell).toBe("/custom/codex");
  });

  test("starts Claude interactively without consuming the prompt as an argument", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(buildInteractiveAgentInvocation("claude", "Fix `api`; then test it")).toEqual({
      shell: "claude",
      args: [],
    });
  });

  test("keeps Codex in the terminal's normal screen buffer", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(buildInteractiveAgentInvocation("codex", "Review this workspace")).toEqual({
      shell: "codex",
      args: ["--no-alt-screen"],
    });
  });

  test("sends the complete prompt and Enter as separate terminal inputs", async () => {
    const { initialAgentInputSequence, initialAgentSubmitDelay } = await loadAgentTerminal();

    expect(initialAgentInputSequence("  First line\nSecond line  ")).toEqual([
      "\u001b[200~  First line\nSecond line  \u001b[201~",
      "\r",
    ]);
    expect(initialAgentSubmitDelay("codex")).toBe(75);
    expect(initialAgentSubmitDelay("claude")).toBe(500);
  });

  test("rejects providers outside the allowlist", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(() => buildInteractiveAgentInvocation("bash", "Do something")).toThrow(
      "Unsupported agent provider",
    );
  });

  test("rejects a blank prompt", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(() => buildInteractiveAgentInvocation("claude", "  \n\t ")).toThrow(
      "Prompt is required",
    );
  });
});
