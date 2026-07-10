import { describe, expect, test } from "vitest";
import { buildInteractiveAgentInvocation } from "../src/core/agent-terminal.js";

describe("interactive agent terminal invocation", () => {
  test("passes a Claude prompt as one uninterpolated argument", () => {
    expect(buildInteractiveAgentInvocation("claude", "Fix `api`; then test it")).toEqual({
      shell: "claude",
      args: ["Fix `api`; then test it"],
    });
  });

  test("keeps Codex in the terminal's normal screen buffer", () => {
    expect(buildInteractiveAgentInvocation("codex", "Review this workspace")).toEqual({
      shell: "codex",
      args: ["--no-alt-screen", "Review this workspace"],
    });
  });

  test("rejects providers outside the allowlist", () => {
    expect(() => buildInteractiveAgentInvocation("bash", "Do something")).toThrow(
      "Unsupported agent provider",
    );
  });

  test("rejects a blank prompt", () => {
    expect(() => buildInteractiveAgentInvocation("claude", "  \n\t ")).toThrow(
      "Prompt is required",
    );
  });
});
