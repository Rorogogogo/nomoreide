// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act, type ReactNode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  OperationProvider,
  useOperations,
  type OperationContextValue,
} from "../src/web/client/src/components/operations/operation-context";
import { LifecycleActions } from "../src/web/client/src/features/services/service-actions";
import { IssueDetail } from "../src/web/client/src/features/github/issue-detail";
import { PrDetail } from "../src/web/client/src/features/github/pr-detail";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubPRReviewCockpit,
} from "../src/web/client/src/lib/api";

const api = vi.hoisted(() => ({
  getGitHubPRReviewCockpit: vi.fn(),
  mergeGitHubPR: vi.fn(),
  postForm: vi.fn(),
  restartService: vi.fn(),
  startBundleProgressive: vi.fn(),
  startService: vi.fn(),
  stopBundle: vi.fn(),
  stopService: vi.fn(),
}));

const ui = vi.hoisted(() => ({
  sendToAgent: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/web/client/src/lib/api")>()),
  ...api,
}));

vi.mock("@/components/ui/toast", () => ({
  useToasts: () => ({ error: ui.toastError, success: ui.toastSuccess }),
}));

vi.mock("@/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ sendToAgent: ui.sendToAgent }),
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

async function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let operations: OperationContextValue | undefined;
  await act(async () => {
    root.render(
      <OperationProvider>
        <Capture onValue={(value) => { operations = value; }} />
        {node}
      </OperationProvider>,
    );
  });
  return {
    host,
    get operations() {
      if (!operations) throw new Error("operation provider has not rendered");
      return operations;
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function setValue(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const issue: GitHubIssue = {
  number: 42,
  title: "Checkout fails",
  state: "open",
  body: "Steps to reproduce",
  html_url: "https://github.com/acme/repo/issues/42",
  user: { login: "robert" },
  labels: [],
  created_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-20T00:00:00Z",
  comments: 0,
};

const pr: GitHubPR = {
  number: 7,
  title: "Ship checkout",
  state: "open",
  body: null,
  html_url: "https://github.com/acme/repo/pull/7",
  head: { ref: "checkout", sha: "abc" },
  base: { ref: "main" },
  user: { login: "robert" },
  created_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-20T00:00:00Z",
  merged_at: null,
  draft: false,
  mergeable: true,
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.getGitHubPRReviewCockpit.mockResolvedValue({
    pr,
    files: [],
    reviews: [],
    comments: [],
    checks: { sha: "abc", state: "success", totalCount: 0, runs: [] },
  } satisfies GitHubPRReviewCockpit);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("global mutation feedback", () => {
  test("tracks service lifecycle by resource and action", async () => {
    const request = deferred<void>();
    api.startService.mockReturnValue(request.promise);
    const mounted = await render(
      <LifecycleActions
        active={false}
        baseUrl="/api/services/web"
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        resourceKind="service"
        resourceName="web"
        targetLabel="web"
      />,
    );
    const button = mounted.host.querySelector<HTMLButtonElement>('button[aria-label="Start"]');

    act(() => button?.click());

    expect(mounted.operations.operations[0]).toMatchObject({ key: "service:web:start" });
    expect(button?.getAttribute("aria-busy")).toBe("true");
    act(() => button?.click());
    expect(api.startService).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve());
    expect(mounted.operations.operations).toEqual([]);
    await mounted.unmount();
  });

  test("tracks issue comment posting and prevents a duplicate submit", async () => {
    const request = deferred<void>();
    const onAddComment = vi.fn(() => request.promise);
    const mounted = await render(
      <IssueDetail
        commentError={null}
        comments={[]}
        commentsLoading={false}
        issue={issue}
        onAddComment={onAddComment}
        submitting={false}
      />,
    );
    setValue(mounted.host.querySelector("textarea")!, "Looks good");
    const button = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Comment"));

    act(() => button?.click());

    expect(mounted.operations.operations[0]).toMatchObject({
      key: "github:issue:42:comment",
    });
    expect(button?.textContent).toContain("Posting…");
    expect(button?.getAttribute("aria-busy")).toBe("true");
    act(() => button?.click());
    expect(onAddComment).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve());
    await mounted.unmount();
  });

  test("keeps squash merge pending until GitHub resolves", async () => {
    const request = deferred<void>();
    api.mergeGitHubPR.mockReturnValue(request.promise);
    const mounted = await render(
      <PrDetail
        diff=""
        diffError={null}
        diffLoading={false}
        onMerged={vi.fn()}
        pr={pr}
      />,
    );
    const openConfirm = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Squash & merge"));
    act(() => openConfirm?.click());
    const dialog = document.body.querySelector('[role="dialog"]');
    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent?.includes("Squash & merge"));

    act(() => confirm?.click());

    expect(mounted.operations.operations[0]).toMatchObject({ key: "github:pr:7:merge" });
    expect(dialog?.textContent).toContain("Merging…");
    expect(confirm?.disabled).toBe(true);
    await act(async () => request.resolve());
    expect(mounted.operations.operations).toEqual([]);
    await mounted.unmount();
  });

  test("uses stable keys and shared loading buttons for service save and disconnect", () => {
    const form = readFileSync(
      "src/web/client/src/features/services/service-form/service-form.tsx",
      "utf8",
    );
    const formHook = readFileSync(
      "src/web/client/src/features/services/service-form/use-service-form.ts",
      "utf8",
    );
    const github = readFileSync(
      "src/web/client/src/features/github/github-view.tsx",
      "utf8",
    );

    expect(formHook).toContain('service-form:${initialService?.name ?? "new"}:save');
    expect(form).toContain("loading={saving}");
    expect(form).toContain('loadingLabel={t("common.saving")}');
    expect(github).toContain('key: "github:disconnect"');
    expect(github).toContain("loading={disconnecting}");
    expect(github).toContain('loadingLabel={t("github.disconnecting")}');
  });

  test("does not register query-only refresh or load-more work", () => {
    const sources = [
      "src/web/client/src/features/services/service-actions.tsx",
      "src/web/client/src/features/services/service-form/use-service-form.ts",
      "src/web/client/src/features/github/issue-detail.tsx",
      "src/web/client/src/features/github/pr-detail.tsx",
      "src/web/client/src/features/github/github-view.tsx",
    ].map((path) => readFileSync(path, "utf8")).join("\n");

    expect(sources).not.toContain('key: "github:refresh"');
    expect(sources).not.toContain('key: "github:load-more"');
    expect(sources).not.toContain('key: "service:test-command"');
  });
});
