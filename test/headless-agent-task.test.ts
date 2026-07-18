import { beforeEach, describe, expect, test, vi } from "vitest";
import { runHeadlessAgentTask } from "../src/web/client/src/features/agent/headless/run-headless-agent-task";

const api = vi.hoisted(() => ({
  approveAgentTool: vi.fn(),
  streamAgentChat: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      expect.any(AbortSignal),
      true,
      "codex",
    );
    expect(api.streamAgentChat.mock.calls[0]?.[3]).not.toBe(signal);
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

  test("aborts an open stream and rejects with the approval error", async () => {
    const approvalError = new Error("approval failed");
    const streamStarted = deferred<AbortSignal>();
    api.approveAgentTool.mockRejectedValue(approvalError);
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, onEvent: (event: unknown) => void, signal: AbortSignal) => {
        onEvent({ type: "session", sessionId: "headless-approval" });
        onEvent({ type: "approval_request", requestId: "request-1" });
        streamStarted.resolve(signal);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        });
      },
    );

    const task = runHeadlessAgentTask({ prompt: "approve" });
    const internalSignal = await streamStarted.promise;

    await expect(task).rejects.toBe(approvalError);
    expect(internalSignal.aborted).toBe(true);
  });

  test("drains outstanding approvals when the stream rejects", async () => {
    const approval = deferred<void>();
    const streamError = new Error("stream failed");
    const approvalError = new Error("late approval failed");
    api.approveAgentTool.mockReturnValue(approval.promise);
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, onEvent: (event: unknown) => void) => {
        onEvent({ type: "session", sessionId: "headless-approval" });
        onEvent({ type: "approval_request", requestId: "request-1" });
        throw streamError;
      },
    );

    const task = runHeadlessAgentTask({ prompt: "approve" });
    let settled = false;
    void task.finally(() => {
      settled = true;
    }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);

    approval.reject(approvalError);
    await expect(task).rejects.toBe(approvalError);
  });

  test("forwards external aborts to the internal stream signal", async () => {
    const external = new AbortController();
    let internalSignal!: AbortSignal;
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, _onEvent, signal: AbortSignal) => {
        internalSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        });
      },
    );

    const task = runHeadlessAgentTask({ prompt: "wait", signal: external.signal });
    external.abort();

    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(internalSignal.aborted).toBe(true);
  });
});
