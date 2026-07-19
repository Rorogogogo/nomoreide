// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  OperationProvider,
  useOperations,
  type OperationContextValue,
} from "../src/web/client/src/components/operations/operation-context";
import { OperationStrip } from "../src/web/client/src/components/operations/operation-strip";

vi.mock("@/components/ui/toast", () => ({
  useToasts: () => ({ error: vi.fn(), success: vi.fn() }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Capture({ onValue }: { onValue: (value: OperationContextValue) => void }) {
  const value = useOperations();
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}

async function mountStrip() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let current: OperationContextValue | undefined;
  await act(async () => {
    root.render(
      <OperationProvider>
        <Capture onValue={(value) => { current = value; }} />
        <OperationStrip />
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
  window.localStorage.clear();
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("OperationStrip", () => {
  test("waits 300ms before announcing a pending operation", async () => {
    const mounted = await mountStrip();
    const action = deferred<void>();
    act(() => {
      void mounted.value.runOperation({ label: "Starting web…" }, () => action.promise);
    });

    expect(mounted.host.querySelector('[role="status"]')).toBeNull();
    act(() => vi.advanceTimersByTime(299));
    expect(mounted.host.querySelector('[role="status"]')).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    const strip = mounted.host.querySelector('[role="status"]');
    expect(strip?.textContent).toContain("Starting web…");
    expect(strip?.getAttribute("aria-live")).toBe("polite");
    expect(strip?.className).toContain("motion-reduce:transition-none");
    await unmount(mounted.root, mounted.host);
  });

  test("summarizes multiple operations and expands their labels", async () => {
    const mounted = await mountStrip();
    const first = deferred<void>();
    const second = deferred<void>();
    act(() => {
      void mounted.value.runOperation({ label: "Saving settings…" }, () => first.promise);
      void mounted.value.runOperation({ label: "Starting API…" }, () => second.promise);
    });
    act(() => vi.advanceTimersByTime(300));

    expect(mounted.host.textContent).toContain("2 operations in progress");
    const toggle = mounted.host.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    );
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.getAttribute("aria-label")).toBe("Show operation details");

    act(() => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("Hide operation details");
    expect(mounted.host.textContent).toContain("Saving settings…");
    expect(mounted.host.textContent).toContain("Starting API…");
    await unmount(mounted.root, mounted.host);
  });

  test("removes the strip when all operations complete", async () => {
    const mounted = await mountStrip();
    const action = deferred<void>();
    act(() => {
      void mounted.value.runOperation({ label: "Saving…" }, () => action.promise);
    });
    act(() => vi.advanceTimersByTime(300));
    expect(mounted.host.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => action.resolve());
    expect(mounted.host.querySelector('[role="status"]')).toBeNull();
    await unmount(mounted.root, mounted.host);
  });
});
