// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  OperationProvider,
  useOperations,
  type OperationContextValue,
  type OperationInput,
} from "../apps/dashboard/src/components/operations/operation-context";

const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  useToasts: () => toasts,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function Capture({ onValue }: { onValue: (value: OperationContextValue) => void }) {
  const value = useOperations();
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}

async function mountProvider() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let current: OperationContextValue | undefined;
  await act(async () => {
    root.render(
      <OperationProvider>
        <Capture onValue={(value) => { current = value; }} />
      </OperationProvider>,
    );
  });
  return {
    get value() {
      if (!current) throw new Error("provider has not rendered");
      return current;
    },
    host,
    root,
  };
}

async function unmount(root: Root, host: HTMLElement) {
  await act(async () => root.unmount());
  host.remove();
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("OperationProvider", () => {
  test("registers a pending operation and returns the action result", async () => {
    const mounted = await mountProvider();
    const action = deferred<string>();
    const input: OperationInput = {
      key: "service:web:start",
      label: "Starting web…",
      successMessage: "Web started",
    };
    let result!: Promise<string>;

    act(() => {
      result = mounted.value.runOperation(input, () => action.promise);
    });

    expect(mounted.value.isPending("service:web:start")).toBe(true);
    expect(mounted.value.operations).toHaveLength(1);
    expect(mounted.value.operations[0]).toMatchObject({
      key: "service:web:start",
      label: "Starting web…",
    });
    await act(async () => action.resolve("started"));

    await expect(result).resolves.toBe("started");
    expect(mounted.value.operations).toEqual([]);
    expect(toasts.success).toHaveBeenCalledWith("Web started");
    await unmount(mounted.root, mounted.host);
  });

  test("cleans up after rejection and rethrows the original error", async () => {
    const mounted = await mountProvider();
    const action = deferred<void>();
    const failure = new Error("socket closed");
    let result!: Promise<void>;

    act(() => {
      result = mounted.value.runOperation(
        {
          key: "service:web:stop",
          label: "Stopping web…",
          errorMessage: (error) => `Could not stop: ${(error as Error).message}`,
        },
        () => action.promise,
      );
    });
    const rejection = expect(result).rejects.toBe(failure);
    await act(async () => action.reject(failure));

    await rejection;
    expect(mounted.value.operations).toEqual([]);
    expect(toasts.error).toHaveBeenCalledWith("Could not stop: socket closed");
    await unmount(mounted.root, mounted.host);
  });

  test("tracks unrelated operations independently", async () => {
    const mounted = await mountProvider();
    const first = deferred<number>();
    const second = deferred<number>();
    let firstResult!: Promise<number>;
    let secondResult!: Promise<number>;

    act(() => {
      firstResult = mounted.value.runOperation(
        { key: "first", label: "First" },
        () => first.promise,
      );
      secondResult = mounted.value.runOperation(
        { key: "second", label: "Second" },
        () => second.promise,
      );
    });
    expect(mounted.value.operations.map(({ key }) => key)).toEqual(["first", "second"]);

    await act(async () => first.resolve(1));
    await expect(firstResult).resolves.toBe(1);
    expect(mounted.value.operations.map(({ key }) => key)).toEqual(["second"]);

    await act(async () => second.resolve(2));
    await expect(secondResult).resolves.toBe(2);
    expect(mounted.value.operations).toEqual([]);
    await unmount(mounted.root, mounted.host);
  });

  test("deduplicates a key synchronously without invoking the action twice", async () => {
    const mounted = await mountProvider();
    const action = deferred<string>();
    const run = vi.fn(() => action.promise);
    let first!: Promise<string>;
    let duplicate!: Promise<string>;

    act(() => {
      first = mounted.value.runOperation({ key: "save", label: "Saving…" }, run);
      duplicate = mounted.value.runOperation({ key: "save", label: "Saving…" }, run);
    });

    expect(duplicate).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(mounted.value.operations).toHaveLength(1);
    await act(async () => action.resolve("saved"));
    await expect(duplicate).resolves.toBe("saved");
    await unmount(mounted.root, mounted.host);
  });

  test("settles safely after the provider unmounts", async () => {
    const mounted = await mountProvider();
    const action = deferred<string>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let result!: Promise<string>;
    act(() => {
      result = mounted.value.runOperation({ label: "Saving…" }, () => action.promise);
    });

    await unmount(mounted.root, mounted.host);
    action.resolve("saved");

    await expect(result).resolves.toBe("saved");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
