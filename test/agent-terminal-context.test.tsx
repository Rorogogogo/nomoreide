// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AgentProvider,
  useAgentDock,
} from "../src/web/client/src/features/agent/chat/agent-context";

const api = vi.hoisted(() => ({
  approveAgentTool: vi.fn(),
  closeTerminalSession: vi.fn(),
  createAgentTerminalSession: vi.fn(),
  getAgentChatStatus: vi.fn(),
  listTerminalSessions: vi.fn(),
  setChatProvider: vi.fn(),
  streamAgentChat: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

type Dock = ReturnType<typeof useAgentDock>;

const claude = {
  id: "claude" as const,
  label: "Claude Code",
  commandName: "claude",
  installHint: "",
  intro: "",
};
const codex = {
  id: "codex" as const,
  label: "Codex",
  commandName: "codex",
  installHint: "",
  intro: "",
};
const providers = [
  { ...claude, configured: true },
  { ...codex, configured: true },
];

function session(
  id: string,
  kind: "agent" | "shell" | "service" = "agent",
  provider: "claude" | "codex" = "claude",
) {
  return {
    id,
    cwd: "/repo",
    cols: 100,
    rows: 30,
    shell: provider,
    state: "running" as const,
    kind,
    provider,
    label: id,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Capture({ onValue }: { onValue: (value: Dock) => void }) {
  const value = useAgentDock();
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}

async function mountProvider() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let current: Dock | undefined;
  const onValue = (value: Dock) => {
    current = value;
  };
  await act(async () => {
    root.render(
      <AgentProvider>
        <Capture onValue={onValue} />
      </AgentProvider>,
    );
  });
  return {
    get value() {
      if (!current) throw new Error("provider has not rendered");
      return current;
    },
    root,
    host,
  };
}

async function unmount(root: Root, host: HTMLElement) {
  await act(async () => root.unmount());
  host.remove();
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.getAgentChatStatus.mockResolvedValue({
    configured: true,
    approvals: false,
    provider: claude,
    providers,
  });
  api.listTerminalSessions.mockResolvedValue([]);
  api.closeTerminalSession.mockResolvedValue(undefined);
  api.setChatProvider.mockImplementation(async (id: "claude" | "codex") =>
    id === "codex" ? codex : claude,
  );
  api.streamAgentChat.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("AgentProvider terminal tasks", () => {
  test("starts rapid sends concurrently and keeps the newest foreground task active", async () => {
    const first = deferred<ReturnType<typeof session>>();
    const second = deferred<ReturnType<typeof session>>();
    api.createAgentTerminalSession
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const mounted = await mountProvider();

    let firstResult: { queued: boolean } | undefined;
    let secondResult: { queued: boolean } | undefined;
    act(() => {
      firstResult = mounted.value.sendToAgent({ prompt: "first", label: "First" });
      secondResult = mounted.value.sendToAgent({ prompt: "second", label: "Second" });
    });

    expect(firstResult).toEqual({ queued: false });
    expect(secondResult).toEqual({ queued: false });
    expect(api.createAgentTerminalSession).toHaveBeenCalledTimes(2);
    expect(api.createAgentTerminalSession).toHaveBeenNthCalledWith(1, {
      provider: "claude",
      prompt: "first",
      label: "First",
    });
    expect(api.createAgentTerminalSession).toHaveBeenNthCalledWith(2, {
      provider: "claude",
      prompt: "second",
      label: "Second",
    });

    await act(async () => second.resolve(session("task-2")));
    await act(async () => first.resolve(session("task-1")));
    expect(mounted.value.tasks.map((task) => task.id)).toEqual(["task-1", "task-2"]);
    expect(mounted.value.activeTaskId).toBe("task-2");
    expect(mounted.value.open).toBe(true);
    await unmount(mounted.root, mounted.host);
  });

  test("creates a background task without opening the dock or stealing the active task", async () => {
    api.listTerminalSessions.mockResolvedValue([session("existing")]);
    api.createAgentTerminalSession.mockResolvedValue(session("background"));
    const mounted = await mountProvider();
    expect(mounted.value.activeTaskId).toBe("existing");

    act(() => mounted.value.sendToAgent({ prompt: "quiet", background: true }));
    await act(async () => {});

    expect(mounted.value.tasks.map((task) => task.id)).toContain("background");
    expect(mounted.value.activeTaskId).toBe("existing");
    expect(mounted.value.open).toBe(false);
    await unmount(mounted.root, mounted.host);
  });

  test("opens a draft without creating a terminal task", async () => {
    const mounted = await mountProvider();

    let result: { queued: boolean } | undefined;
    act(() => {
      result = mounted.value.sendToAgent({
        prompt: "editable prompt",
        mode: "draft",
        source: { type: "service", label: "api" },
      });
    });

    expect(result).toEqual({ queued: false });
    expect(mounted.value.open).toBe(true);
    expect(mounted.value.draft).toBe("editable prompt");
    expect(mounted.value.activeSource).toEqual({ type: "service", label: "api" });
    expect(api.createAgentTerminalSession).not.toHaveBeenCalled();
    await unmount(mounted.root, mounted.host);
  });

  test("persists provider selection and uses it for new tasks", async () => {
    api.createAgentTerminalSession.mockResolvedValue(session("codex-task", "agent", "codex"));
    const mounted = await mountProvider();

    await act(async () => mounted.value.selectProvider("codex"));
    act(() => mounted.value.sendToAgent({ prompt: "use codex" }));
    await act(async () => {});

    expect(api.setChatProvider).toHaveBeenCalledWith("codex");
    expect(mounted.value.provider?.id).toBe("codex");
    expect(api.createAgentTerminalSession).toHaveBeenCalledWith({
      provider: "codex",
      prompt: "use codex",
      label: undefined,
    });
    await unmount(mounted.root, mounted.host);
  });

  test("surfaces provider persistence failures without reverting the optimistic choice", async () => {
    api.setChatProvider.mockRejectedValue(new Error("Cannot save provider"));
    const mounted = await mountProvider();

    await act(async () => mounted.value.selectProvider("codex"));

    expect(mounted.value.provider?.id).toBe("codex");
    expect(mounted.value.error).toBe("Cannot save provider");
    await unmount(mounted.root, mounted.host);
  });

  test("reattaches only existing agent terminal sessions", async () => {
    api.listTerminalSessions.mockResolvedValue([
      session("agent-one"),
      session("shell-one", "shell"),
      session("service-one", "service"),
    ]);
    const mounted = await mountProvider();

    expect(mounted.value.tasks.map((task) => task.id)).toEqual(["agent-one"]);
    expect(mounted.value.activeTaskId).toBe("agent-one");
    await unmount(mounted.root, mounted.host);
  });

  test("closes only the target and selects its adjacent task", async () => {
    api.listTerminalSessions.mockResolvedValue([
      session("one"),
      session("two"),
      session("three"),
    ]);
    const mounted = await mountProvider();
    act(() => mounted.value.setActiveTaskId("two"));

    await act(async () => mounted.value.closeTask("two"));

    expect(api.closeTerminalSession).toHaveBeenCalledTimes(1);
    expect(api.closeTerminalSession).toHaveBeenCalledWith("two");
    expect(mounted.value.tasks.map((task) => task.id)).toEqual(["one", "three"]);
    expect(mounted.value.activeTaskId).toBe("three");
    await unmount(mounted.root, mounted.host);
  });

  test("surfaces create failures without corrupting existing tasks", async () => {
    api.listTerminalSessions.mockResolvedValue([session("safe")]);
    api.createAgentTerminalSession.mockRejectedValue(new Error("CLI missing"));
    api.streamAgentChat.mockImplementation(
      async (_message, _sessionId, onEvent: (event: unknown) => void) => {
        onEvent({ type: "error", message: "obsolete chat error" });
      },
    );
    const mounted = await mountProvider();

    act(() => mounted.value.sendToAgent({ prompt: "fail" }));
    await act(async () => {});
    await act(async () => mounted.value.send("legacy bridge"));

    expect(mounted.value.tasks.map((task) => task.id)).toEqual(["safe"]);
    expect(mounted.value.activeTaskId).toBe("safe");
    expect(mounted.value.terminalError).toBe("CLI missing");
    expect(mounted.value.error).toBe("CLI missing");
    await unmount(mounted.root, mounted.host);
  });

  test("inserts paths into the draft and opens the dock", async () => {
    const mounted = await mountProvider();

    act(() => mounted.value.setDraft("Review this"));
    act(() => mounted.value.insertPath("src/app.ts"));

    expect(mounted.value.draft).toBe("Review this\nsrc/app.ts");
    expect(mounted.value.open).toBe(true);
    expect(mounted.value.focusNonce).toBeGreaterThan(0);
    await unmount(mounted.root, mounted.host);
  });
});
