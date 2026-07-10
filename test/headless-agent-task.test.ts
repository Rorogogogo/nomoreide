import { beforeEach, describe, expect, test, vi } from "vitest";
import { runHeadlessAgentTask } from "../src/web/client/src/features/agent/headless/run-headless-agent-task";

const api = vi.hoisted(() => ({
  approveAgentTool: vi.fn(),
  streamAgentChat: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

beforeEach(() => {
  vi.clearAllMocks();
  api.approveAgentTool.mockResolvedValue(undefined);
});

describe("runHeadlessAgentTask", () => {
  test("runs a fresh provider session and returns all streamed text", async () => {
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, onEvent: (event: unknown) => void) => {
        onEvent({ type: "session", sessionId: "headless-1" });
        onEvent({ type: "text", text: " first " });
        onEvent({ type: "text", text: "second\n" });
      },
    );
    const signal = new AbortController().signal;

    const result = await runHeadlessAgentTask({
      prompt: "do work",
      provider: "codex",
      autoApprove: true,
      signal,
    });

    expect(result).toBe("first second");
    expect(api.streamAgentChat).toHaveBeenCalledWith(
      "do work",
      undefined,
      expect.any(Function),
      signal,
      true,
      "codex",
    );
  });

  test.each([
    [true, "allow"],
    [false, "deny"],
  ] as const)("answers approvals safely when autoApprove is %s", async (autoApprove, decision) => {
    const approval = new Promise<void>((resolve) => {
      api.approveAgentTool.mockImplementation(async () => resolve());
    });
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, onEvent: (event: unknown) => void) => {
        onEvent({ type: "session", sessionId: "headless-approval" });
        onEvent({ type: "approval_request", requestId: "request-1" });
        onEvent({ type: "text", text: "done" });
      },
    );

    await expect(
      runHeadlessAgentTask({ prompt: "approve", provider: "claude", autoApprove }),
    ).resolves.toBe("done");
    await approval;
    expect(api.approveAgentTool).toHaveBeenCalledWith(
      "headless-approval",
      "request-1",
      decision,
    );
  });

  test("rejects when the stream reports an error", async () => {
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, onEvent: (event: unknown) => void) => {
        onEvent({ type: "error", message: "agent failed" });
      },
    );

    await expect(
      runHeadlessAgentTask({ prompt: "fail", provider: "claude" }),
    ).rejects.toThrow("agent failed");
  });
});
