// @vitest-environment happy-dom

import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useSqlGenerate } from "../apps/dashboard/src/features/database/use-sql-generate";
import { useWorkflowRunner } from "../apps/dashboard/src/features/workflows/use-workflow-runner";

const api = vi.hoisted(() => ({
  approveAgentTool: vi.fn(),
  getDatabaseTables: vi.fn(),
  getGitStatus: vi.fn(),
  gitCheckoutDefaultAndPull: vi.fn(),
  gitCommit: vi.fn(),
  gitPush: vi.fn(),
  gitStage: vi.fn(),
  streamAgentChat: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("@/lib/api", () => api);
vi.mock("../apps/dashboard/src/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ provider: { id: "codex" } }),
}));

async function mountHarness<T>(useValue: () => T, strict = false) {
  let current: T | undefined;
  function Harness() {
    const value = useValue();
    useEffect(() => {
      current = value;
    }, [value]);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(strict ? (
      <StrictMode>
        <Harness />
      </StrictMode>
    ) : (
      <Harness />
    )),
  );
  return {
    get value() {
      if (!current) throw new Error("hook has not rendered");
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
  api.approveAgentTool.mockResolvedValue(undefined);
  api.getDatabaseTables.mockResolvedValue([]);
  api.getGitStatus.mockResolvedValue({ branch: "feature/test", ahead: 0, behind: 0, files: [] });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("headless result consumers", () => {
  test("completes a workflow agent step from its headless streamed result", async () => {
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, onEvent: (event: unknown) => void) => {
        onEvent({ type: "session", sessionId: "workflow-headless" });
        onEvent({ type: "text", text: "Implemented the change\nWORKFLOW_STATUS: ok" });
      },
    );
    const mounted = await mountHarness(() => useWorkflowRunner());

    act(() => {
      mounted.value.start({
        id: "headless-workflow",
        name: "Headless workflow",
        steps: [{ kind: "agent", id: "agent-1", title: "Implement", prompt: "Do it" }],
      });
    });
    await act(async () => {});

    expect(mounted.value.run?.outcome).toBe("done");
    expect(mounted.value.run?.outputs[0]).toBe("Implemented the change");
    expect(api.streamAgentChat).toHaveBeenCalledWith(
      expect.stringContaining("Do it"),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
      false,
      "codex",
    );
    await unmount(mounted.root, mounted.host);
  });

  test("completes a workflow after Strict Mode replays its effects", async () => {
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, onEvent: (event: unknown) => void) => {
        onEvent({ type: "text", text: "Done\nWORKFLOW_STATUS: ok" });
      },
    );
    const mounted = await mountHarness(() => useWorkflowRunner(), true);

    act(() => {
      mounted.value.start({
        id: "strict-workflow",
        name: "Strict workflow",
        steps: [{ kind: "agent", id: "agent-1", title: "Implement", prompt: "Do it" }],
      });
    });
    await act(async () => {});

    expect(mounted.value.run?.outcome).toBe("done");
    expect(api.streamAgentChat).toHaveBeenCalledOnce();
    await unmount(mounted.root, mounted.host);
  });

  test("generates SQL directly from headless streamed text", async () => {
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, onEvent: (event: unknown) => void) => {
        onEvent({ type: "session", sessionId: "sql-headless" });
        onEvent({ type: "text", text: "```sql\nSELECT * FROM users;\n```" });
      },
    );
    const onGenerated = vi.fn();
    const mounted = await mountHarness(() =>
      useSqlGenerate("local", "postgres", false, onGenerated),
    );

    await act(async () => mounted.value.generate("show users"));

    expect(onGenerated).toHaveBeenCalledWith("SELECT * FROM users;");
    expect(api.streamAgentChat).toHaveBeenCalledWith(
      expect.stringContaining("show users"),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
      false,
      "codex",
    );
    await unmount(mounted.root, mounted.host);
  });

  test("does not start SQL generation after unmounting during table discovery", async () => {
    const tables = deferred<[]>();
    api.getDatabaseTables.mockReturnValue(tables.promise);
    const mounted = await mountHarness(() =>
      useSqlGenerate("local", "postgres", false, vi.fn()),
    );

    let generation!: Promise<void>;
    act(() => {
      generation = mounted.value.generate("show users");
    });
    await unmount(mounted.root, mounted.host);
    tables.resolve([]);
    await generation;

    expect(api.streamAgentChat).not.toHaveBeenCalled();
  });

  test("stops SQL generation and ignores the aborted agent response", async () => {
    let capturedSignal!: AbortSignal;
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, _onEvent, signal: AbortSignal) => {
        capturedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const onGenerated = vi.fn();
    const mounted = await mountHarness(() =>
      useSqlGenerate("local", "postgres", false, onGenerated),
    );

    let generation!: Promise<void>;
    act(() => {
      generation = mounted.value.generate("show users");
    });
    await act(async () => Promise.resolve());
    act(() => mounted.value.cancel());

    expect(capturedSignal.aborted).toBe(true);
    expect(mounted.value.generating).toBe(false);
    await act(async () => generation);
    expect(onGenerated).not.toHaveBeenCalled();
    await unmount(mounted.root, mounted.host);
  });

  test("aborts a running workflow agent and does not refresh after unmount", async () => {
    const onRefresh = vi.fn();
    let capturedSignal!: AbortSignal;
    api.streamAgentChat.mockImplementation(
      async (_prompt, _resume, _onEvent, signal: AbortSignal) => {
        capturedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        });
      },
    );
    const mounted = await mountHarness(() => useWorkflowRunner(onRefresh), true);

    act(() => {
      mounted.value.start({
        id: "unmount-workflow",
        name: "Unmount workflow",
        steps: [{ kind: "agent", id: "agent-1", title: "Wait", prompt: "Wait" }],
      });
    });
    await act(async () => Promise.resolve());
    await unmount(mounted.root, mounted.host);
    await Promise.resolve();

    expect(capturedSignal.aborted).toBe(true);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
