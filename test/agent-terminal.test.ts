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

describe("interactive agent terminal invocation", () => {
  test("uses configured Claude and Codex binaries", async () => {
    const buildInvocation = await loadInvocationBuilder("/custom/claude", "/custom/codex");

    expect(buildInvocation("claude", "Fix it").shell).toBe("/custom/claude");
    expect(buildInvocation("codex", "Review it").shell).toBe("/custom/codex");
  });

  test("passes the prompt to Claude as a positional argument", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(buildInteractiveAgentInvocation("claude", "Fix `api`; then test it")).toEqual({
      shell: "claude",
      args: ["Fix `api`; then test it"],
    });
  });

  test("keeps Codex in the normal screen buffer and passes the prompt", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(buildInteractiveAgentInvocation("codex", "Review this workspace")).toEqual({
      shell: "codex",
      args: ["--no-alt-screen", "Review this workspace"],
    });
  });

  test("rejects providers outside the allowlist", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(() => buildInteractiveAgentInvocation("bash", "Do something")).toThrow(
      "Unsupported agent provider",
    );
  });

  test("opens an interactive provider session with a blank prompt", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(buildInteractiveAgentInvocation("claude", "  \n\t ")).toEqual({
      shell: "claude",
      args: [],
    });
    expect(buildInteractiveAgentInvocation("codex", "")).toEqual({
      shell: "codex",
      args: ["--no-alt-screen"],
    });
  });

  test("reopens a prior session with no prompt", async () => {
    const buildInvocation = await loadInvocationBuilder();
    const id = "dce2b69c-0fb4-4bd3-b456-b2bef4230c81";

    expect(buildInvocation("claude", "", { resumeId: id })).toEqual({
      shell: "claude",
      args: ["--resume", id],
    });
    expect(buildInvocation("codex", "", { resumeId: id })).toEqual({
      shell: "codex",
      args: ["--no-alt-screen", "resume", id],
    });
  });

  test("appends a prompt to a resumed session", async () => {
    const buildInvocation = await loadInvocationBuilder();
    const id = "019f7c82-cb32-73d3-9ffd-7425ddb8dbb4";

    expect(buildInvocation("claude", "carry on", { resumeId: id }).args).toEqual([
      "--resume",
      id,
      "carry on",
    ]);
    expect(buildInvocation("codex", "carry on", { resumeId: id }).args).toEqual([
      "--no-alt-screen",
      "resume",
      id,
      "carry on",
    ]);
  });

  test("refuses a session id that could be read as a flag", async () => {
    const buildInteractiveAgentInvocation = await loadInvocationBuilder();

    expect(() =>
      buildInteractiveAgentInvocation("claude", "", { resumeId: "--dangerously-skip-permissions" }),
    ).toThrow("Invalid session id");
  });
});
