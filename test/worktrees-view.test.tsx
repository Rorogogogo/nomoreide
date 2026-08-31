// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getGitWorktrees = vi.hoisted(() => vi.fn());
const gitBranches = vi.hoisted(() => vi.fn());
const createGitWorktree = vi.hoisted(() => vi.fn());
const createTask = vi.hoisted(() => vi.fn());
const setAgentDockOpen = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  createGitWorktree,
  getGitWorktrees,
  gitBranches,
  pruneGitWorktrees: vi.fn(),
  removeGitWorktree: vi.fn(),
  selectGitWorktree: vi.fn(),
}));
vi.mock("@/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ createTask, setOpen: setAgentDockOpen }),
}));

import { WorktreesView } from "../apps/dashboard/src/features/git/worktrees-view";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  getGitWorktrees.mockResolvedValue({
    activePath: "/repo",
    worktrees: [],
  });
  gitBranches.mockResolvedValue([
    { name: "main", current: true, remote: false },
    { name: "feature/settings", current: false, remote: false },
    { name: "origin/main", current: false, remote: true },
  ]);
  createGitWorktree.mockResolvedValue({
    path: "/worktrees/feature-task",
    head: "abc123",
    branch: "feature/task",
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
    primary: false,
    dirty: false,
  });
  createTask.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("WorktreesView", () => {
  test("offers searchable branch suggestions while preserving custom Git refs", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<WorktreesView />);
    });

    const newWorktree = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("New worktree"),
    ) as HTMLButtonElement;
    await act(async () => {
      newWorktree.click();
      await Promise.resolve();
    });

    const input = host.querySelector(
      'input[list="worktree-start-points"]',
    ) as HTMLInputElement;
    const options = Array.from(host.querySelectorAll("datalist option"));

    expect(input.value).toBe("HEAD");
    expect(input.placeholder).toBe("Select or enter a Git ref");
    expect(options.map((option) => option.getAttribute("value"))).toEqual([
      "HEAD",
      "main",
      "feature/settings",
      "origin/main",
    ]);
    expect(options.map((option) => option.getAttribute("label"))).toEqual([
      "Current checkout",
      "Local branch",
      "Local branch",
      "Remote branch",
    ]);

    await act(async () => {
      setInputValue(input, "v0.1.95");
    });
    expect(input.value).toBe("v0.1.95");

    await act(async () => root.unmount());
  });

  test("opens the agent dock after launching the worktree agent", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<WorktreesView />);
    });

    const newWorktree = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("New worktree"),
    ) as HTMLButtonElement;
    await act(async () => newWorktree.click());

    const branch = host.querySelector(
      'input[placeholder="feature/my-task"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(branch, "feature/task");
    });
    const form = host.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Worktree: feature/task",
      }),
    );
    expect(setAgentDockOpen).toHaveBeenCalledWith(true);

    await act(async () => root.unmount());
  });

  test("explains active-session behavior and shows worktree creation time", async () => {
    getGitWorktrees.mockResolvedValue({
      activePath: "/worktrees/feature-task",
      worktrees: [{
        path: "/worktrees/feature-task",
        head: "abc123",
        branch: "feature/task",
        createdAt: Date.now() - 120_000,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        primary: false,
        dirty: false,
      }],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<WorktreesView />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain("New agents and workspace terminals start in the active worktree");
    expect(host.textContent).toContain("Created 2 minutes ago");

    await act(async () => root.unmount());
  });
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
