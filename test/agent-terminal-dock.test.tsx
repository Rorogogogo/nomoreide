// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dock = vi.hoisted(() => ({
  activeSource: null as null | { type: string; label: string }, activeTaskId: null as string | null,
  claimInitialInput: vi.fn(), clearSource: vi.fn(), closeTask: vi.fn(), configured: true,
  createShellTask: vi.fn(), createTask: vi.fn(), creating: 0,
  draft: "", focusNonce: 0, insertPath: vi.fn(), onboarding: false, open: false,
  loadTranscripts: vi.fn(),
  provider: { id: "claude", label: "Claude Code", commandName: "claude", installHint: "", intro: "" },
  pendingTaskIds: new Set<string>(),
  providers: [
    { id: "claude", label: "Claude Code", commandName: "claude", installHint: "", intro: "", configured: true },
    { id: "codex", label: "Codex", commandName: "codex", installHint: "npm i codex", intro: "", configured: false },
  ],
  // Selection lives in the provider, so the mock must actually hold it — the
  // dock reads it back to decide whether the compose tab is the current one.
  selectProvider: vi.fn(), setActiveTaskId: vi.fn((id: string | null) => { dock.activeTaskId = id; }),
  setDraft: vi.fn(), setOnboarding: vi.fn(),
  renameTask: vi.fn(),
  resumeTask: vi.fn(),
  setOpen: vi.fn(), stopTask: vi.fn(), tasks: [] as Array<Record<string, unknown>>,
  terminalError: null as string | null,
  transcripts: [] as Array<Record<string, unknown>>,
  transcriptsError: null as string | null,
  transcriptsLoading: false,
  updateTaskStatus: vi.fn(),
}));
const uiSettings = vi.hoisted(() => ({
  confirmedGlobal: { terminal: undefined },
  ui: { agentDockPlacement: "bottom" as "bottom" | "right" },
  updateUi: vi.fn(),
}));

vi.mock("@/features/agent/chat/agent-context", () => ({ useAgentDock: () => dock }));
vi.mock("@/features/settings/settings-context", () => ({
  useOptionalSettings: () => uiSettings,
}));
vi.mock("@/features/terminal/terminal-viewport", () => ({
  TerminalViewport: ({ sessionId, active, onStatusChange }: { sessionId: string; active: boolean; onStatusChange: (s: unknown) => void }) =>
    <button data-active={String(active)} data-session={sessionId} onClick={() => onStatusChange({ state: "running", cwd: "/repo", detail: "claude" })}>viewport</button>,
}));
vi.mock("@/features/agent/chat/file-picker", () => ({ FilePicker: () => null }));
vi.mock("@/features/git/git-situation-banner", () => ({ GitSituationBanner: () => null }));

import { AgentTerminalDock, clampAgentDockHeight, clampAgentDockWidth } from "../src/web/client/src/features/agent/terminal/agent-terminal-dock";

/**
 * Roots mounted by the current test. An unmounted root can still hold work in
 * React's scheduler, which then fires against a torn-down happy-dom and throws
 * "window is not defined" as an unhandled error — so every root gets unmounted
 * before the environment goes away.
 */
let mountedRoots: Array<ReturnType<typeof createRoot>> = [];

async function render(props: ComponentProps<typeof AgentTerminalDock> = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); mountedRoots.push(root);
  await act(async () => root.render(<AgentTerminalDock {...props} />));
  return { host, root };
}

/** Flush a provider-state change the way a real re-render would. */
async function rerender(mounted: { root: ReturnType<typeof createRoot> }) {
  await act(async () => mounted.root.render(<AgentTerminalDock />));
}

async function dragTaskToSplit(host: HTMLElement, taskId: string) {
  const tab = host.querySelector(`#agent-tab-${taskId}`) as HTMLButtonElement;
  await act(async () =>
    tab.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true })),
  );
  const target = host.querySelector(
    '[aria-label="Drop to split view"]',
  ) as HTMLElement;
  expect(target).not.toBeNull();
  await act(async () =>
    target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })),
  );
}

async function dragTaskToLeft(host: HTMLElement, taskId: string) {
  const tab = host.querySelector(`#agent-tab-${taskId}`) as HTMLButtonElement;
  await act(async () =>
    tab.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true })),
  );
  const target = host.querySelector(
    '[aria-label="Drop in left tab group"]',
  ) as HTMLElement;
  expect(target).not.toBeNull();
  await act(async () =>
    target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })),
  );
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); document.body.replaceChildren(); mountedRoots = [];
  uiSettings.ui.agentDockPlacement = "bottom";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  Object.assign(dock, { activeSource: null, activeTaskId: null, configured: true, creating: 0, draft: "", focusNonce: 0, onboarding: false, open: false, pendingTaskIds: new Set(), tasks: [], terminalError: null });
  Object.assign(dock, { transcripts: [], transcriptsError: null, transcriptsLoading: false });
  dock.loadTranscripts.mockResolvedValue([]);
  dock.closeTask.mockResolvedValue(true);
});
afterEach(async () => {
  const roots = mountedRoots; mountedRoots = [];
  await act(async () => { for (const root of roots) root.unmount(); });
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("AgentTerminalDock", () => {
  test("renders a 36px collapsed task rail and expands from the whole rail", async () => {
    const { host } = await render();
    const rail = host.querySelector('[aria-label="Open agent terminal"]') as HTMLButtonElement;
    expect(rail.className).toContain("h-9"); expect(host.textContent).toContain("New agent task");
    act(() => rail.click()); expect(dock.setOpen).toHaveBeenCalledWith(true);
  });

  test("shows the composer start page only when no terminal sessions exist", async () => {
    Object.assign(dock, { open: true, tasks: [], activeTaskId: null });
    const empty = await render();
    expect(empty.host.querySelector('[aria-label="Agent task prompt"]')).not.toBeNull();

    Object.assign(dock, {
      activeTaskId: "one",
      tasks: [{ id: "one", label: "One", state: "running", provider: "claude" }],
    });
    const occupied = await render();
    expect(occupied.host.querySelector('[aria-label="Agent task prompt"]')).toBeNull();
  });

  test("collapsed rail reports only the active task state accessibly", async () => {
    Object.assign(dock, { activeTaskId: "active", tasks: [
      { id: "active", label: "Waiting", state: "exited" },
      { id: "other", label: "Busy", state: "running" },
    ] });
    const { host } = await render();
    expect(host.textContent).toContain("Waiting");
    expect(host.textContent).toContain("Exited");
    expect(host.textContent).toContain("Active task status: Exited");
  });

  test("collapsed rail preserves mounted inactive viewports", async () => {
    Object.assign(dock, {
      activeTaskId: "one",
      open: false,
      tasks: [{ id: "one", label: "One", state: "running", provider: "claude" }],
    });
    const { host } = await render();
    expect(host.querySelector('[data-session="one"]')).not.toBeNull();
    expect(host.querySelector('[data-session="one"]')?.getAttribute("data-active")).toBe("false");
  });

  test("collapsed provider identity follows the active task instead of the selected provider", async () => {
    Object.assign(dock, {
      activeTaskId: "codex-task",
      open: false,
      provider: { ...dock.provider, id: "claude", label: "Claude Code" },
      tasks: [{ id: "codex-task", label: "Review", state: "running", provider: "codex" }],
    });
    const { host } = await render();
    const rail = host.querySelector('[aria-label="Open agent terminal"]') as HTMLButtonElement;
    expect(rail.textContent).toContain("Codex");
    expect(rail.textContent).not.toContain("Claude Code");
  });

  test("submits the full prompt with a compact label and selected provider", async () => {
    Object.assign(dock, { open: true, draft: "  Fix the checkout race and add regression coverage\nDo not skip tests" });
    const { host } = await render();
    const composer = host.querySelector('[aria-label="Agent task prompt"]') as HTMLTextAreaElement;
    act(() => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(dock.createTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "  Fix the checkout race and add regression coverage\nDo not skip tests",
      label: "Fix the checkout race and add regression coverage",
    }));
  });

  test("prefers the source label and clears its source chip after submit", async () => {
    Object.assign(dock, { open: true, draft: "Long generated prompt", activeSource: { type: "service", label: "API service" } });
    dock.createTask.mockResolvedValue({ id: "new" });
    const { host } = await render();
    expect(host.textContent).toContain("API service");
    await act(async () => (host.querySelector('[aria-label="Run agent task"]') as HTMLButtonElement).click());
    expect(dock.createTask).toHaveBeenCalledWith(expect.objectContaining({ label: "API service" }));
    expect(dock.clearSource).toHaveBeenCalled();
  });

  test("opens a selected provider directly from plus and still reveals staged drafts", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [{ id: "one", label: "One", state: "running" }] });
    const mounted = await render();
    expect(mounted.host.querySelector('[aria-label="Agent task prompt"]')).toBeNull();
    await act(async () => (mounted.host.querySelector('[aria-label="Choose a new session"]') as HTMLButtonElement).click());
    const menu = document.body.querySelector('[role="menu"][aria-label="Choose a new session"]');
    expect(menu).not.toBeNull();
    await act(async () => (menu?.querySelector('[role="menuitem"][aria-label="Claude Code"]') as HTMLButtonElement).click());
    expect(dock.createTask).toHaveBeenCalledWith({
      prompt: "",
      provider: "claude",
      label: "Claude Code task",
    });
    expect(dock.setActiveTaskId).not.toHaveBeenCalledWith("new");
    expect(document.body.querySelector('[role="menu"][aria-label="Choose a new session"]')).toBeNull();
    await act(async () => mounted.root.unmount());
    Object.assign(dock, { draft: "staged", focusNonce: 2 });
    const staged = await render();
    expect((staged.host.querySelector('[aria-label="Agent task prompt"]') as HTMLTextAreaElement).value).toBe("staged");
  });

  test("opens repository conversation history and resumes a selected session", async () => {
    const transcript = {
      id: "dce2b69c-0fb4-4bd3-b456-b2bef4230c81",
      provider: "claude",
      cwd: "/repo",
      title: "Finish conversation management",
      startedAt: "2026-07-24T01:00:00.000Z",
      updatedAt: "2026-07-25T01:00:00.000Z",
    };
    Object.assign(dock, { open: true, transcripts: [transcript] });
    dock.resumeTask.mockResolvedValue({ id: "resumed" });
    const { host } = await render();

    await act(async () =>
      (host.querySelector('[aria-label="Open conversation history"]') as HTMLButtonElement).click(),
    );
    expect(dock.loadTranscripts).toHaveBeenCalled();
    expect(document.body.textContent).toContain("Finish conversation management");

    await act(async () =>
      (Array.from(document.body.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Finish conversation management"),
      ) as HTMLButtonElement).click(),
    );
    expect(dock.resumeTask).toHaveBeenCalledWith(transcript);
    expect(document.body.querySelector('[aria-label="Conversations"]')).toBeNull();
  });

  test("searches a scrollable conversation history by title or provider", async () => {
    Object.assign(dock, {
      open: true,
      transcripts: [
        {
          id: "claude-session",
          provider: "claude",
          cwd: "/repo",
          title: "Investigate flaky checkout",
          startedAt: "2026-07-23T01:00:00.000Z",
          updatedAt: "2026-07-24T01:00:00.000Z",
        },
        {
          id: "codex-session",
          provider: "codex",
          cwd: "/repo",
          title: "Polish the dock history",
          startedAt: "2026-07-24T01:00:00.000Z",
          updatedAt: "2026-07-25T01:00:00.000Z",
        },
      ],
    });
    const { host } = await render();

    await act(async () =>
      (host.querySelector('[aria-label="Open conversation history"]') as HTMLButtonElement).click(),
    );
    const scrollRegion = document.body.querySelector("[data-conversation-scroll]");
    expect(scrollRegion?.className).toContain("overflow-y-auto");

    const search = document.body.querySelector(
      '[aria-label="Search conversations"]',
    ) as HTMLInputElement;
    await act(async () => {
      search.value = "codex";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Polish the dock history");
    expect(document.body.textContent).not.toContain("Investigate flaky checkout");
  });

  test("does not reopen a consumed staged draft when the task list changes", async () => {
    Object.assign(dock, {
      open: true,
      activeTaskId: "one",
      draft: "staged task",
      focusNonce: 4,
      tasks: [{ id: "one", label: "One", state: "running" }],
    });
    dock.createTask.mockResolvedValue({ id: "two" });
    const mounted = await render();
    await rerender(mounted);
    expect(mounted.host.querySelector('[aria-label="Agent task prompt"]')).not.toBeNull();
    await act(async () => (mounted.host.querySelector('[aria-label="Run agent task"]') as HTMLButtonElement).click());

    Object.assign(dock, {
      activeTaskId: "two",
      draft: "",
      tasks: [
        { id: "one", label: "One", state: "running" },
        { id: "two", label: "Two", state: "running" },
      ],
    });
    await act(async () => mounted.root.render(<AgentTerminalDock />));

    expect(mounted.host.querySelector('[aria-label="Agent task prompt"]')).toBeNull();
    expect(mounted.host.querySelector('[data-session="two"]')?.getAttribute("data-active")).toBe("true");
  });

  test("onboarding uses the repo prompt and cannot bypass missing configuration", async () => {
    Object.assign(dock, { open: true, onboarding: true, configured: false });
    const { host } = await render();
    const input = host.querySelector('[aria-label="Repository URL"]') as HTMLInputElement;
    act(() => { input.value = "https://github.com/acme/repo"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "Onboard") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(dock.createTask).not.toHaveBeenCalled();

    Object.assign(dock, { configured: true });
    dock.createTask.mockResolvedValue({ id: "repo" });
    const enabled = await render();
    const repoInput = enabled.host.querySelector('[aria-label="Repository URL"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(repoInput, "https://github.com/acme/repo");
      repoInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const repoButton = Array.from(enabled.host.querySelectorAll("button")).find((item) => item.textContent === "Onboard") as HTMLButtonElement;
    await act(async () => repoButton.click());
    expect(dock.createTask).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("https://github.com/acme/repo") }));
  });

  test("provider status loading blocks run, Enter, and onboarding", async () => {
    Object.assign(dock, { open: true, configured: null, draft: "Do work", onboarding: true });
    const { host } = await render();
    expect(host.textContent).toContain("Checking");
    const run = host.querySelector('[aria-label="Run agent task"]') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    const onboard = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "Onboard") as HTMLButtonElement;
    expect(onboard.disabled).toBe(true);
    act(() => (host.querySelector('[aria-label="Agent task prompt"]') as HTMLTextAreaElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(dock.createTask).not.toHaveBeenCalled();
  });

  test("opens repo onboarding over an existing active terminal when onboarding starts", async () => {
    Object.assign(dock, {
      open: true,
      activeTaskId: "one",
      onboarding: false,
      tasks: [{ id: "one", label: "One", state: "running" }],
    });
    const mounted = await render();
    expect(mounted.host.querySelector('[aria-label="Repository URL"]')).toBeNull();

    dock.onboarding = true;
    await rerender(mounted);
    await rerender(mounted);

    expect(mounted.host.querySelector('[aria-label="Repository URL"]')).not.toBeNull();
    expect(mounted.host.querySelector('[aria-label="Agent task prompt"]')).not.toBeNull();
  });

  test("keeps every viewport mounted and switches labelled tabs", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "exited", provider: "codex" },
    ] });
    const { host } = await render();
    expect(host.querySelectorAll("[data-session]")).toHaveLength(2);
    expect(host.querySelector('[data-session="one"]')?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector('[data-session="two"]')?.getAttribute("data-active")).toBe("false");
    act(() => (host.querySelector('[aria-label="Open task Second task"]') as HTMLButtonElement).click());
    expect(dock.setActiveTaskId).toHaveBeenCalledWith("two");
  });

  test("closing an inactive left tab preserves the current selection", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
    ] });
    const { host } = await render();

    await act(async () =>
      (host.querySelector('[aria-label="Close task Second task"]') as HTMLButtonElement).click(),
    );

    expect(dock.closeTask).toHaveBeenCalledWith("two", "one");
    expect(dock.setActiveTaskId).not.toHaveBeenCalled();
  });

  test("arrow keys navigate tabs with a single tab stop", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
    ] });
    const { host } = await render();
    const first = host.querySelector("#agent-tab-one") as HTMLButtonElement;
    const second = host.querySelector("#agent-tab-two") as HTMLButtonElement;
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);

    await act(async () =>
      first.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })),
    );

    expect(dock.setActiveTaskId).toHaveBeenCalledWith("two");
  });

  test("splits a dragged task and keeps it in the right group when activated", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
    ] });
    const mounted = await render();
    const { host } = mounted;
    expect(host.querySelector("#agent-tab-one")?.getAttribute("draggable")).toBe("true");
    expect(host.querySelector("#agent-tab-two")?.getAttribute("draggable")).toBe("true");
    await dragTaskToSplit(host, "two");

    const left = host.querySelector('#agent-panel-one') as HTMLElement;
    const right = host.querySelector('#agent-panel-two') as HTMLElement;
    expect(left.style.right).toBe("50%");
    expect(right.style.left).toBe("50%");
    expect(left.className).not.toContain("invisible");
    expect(right.className).not.toContain("invisible");
    expect(host.querySelector('[data-session="two"]')?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector("[data-agent-dock-toolbar] [role=tablist]")).toBeNull();
    expect(host.querySelector('[data-agent-pane-tabs="left"]')?.textContent).toContain("First task");
    expect(host.querySelector('[data-agent-pane-tabs="right"]')?.textContent).toContain("Second task");

    act(() => (host.querySelector('[aria-label="Open task Second task"]') as HTMLButtonElement).click());
    await rerender(mounted);
    expect((host.querySelector('#agent-panel-one') as HTMLElement).className).not.toContain("invisible");
    expect((host.querySelector('#agent-panel-two') as HTMLElement).className).not.toContain("invisible");
    expect(host.querySelector('[data-agent-pane-tabs="right"]')).not.toBeNull();
  });

  test("drags the right tab back into the left group", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
    ] });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");
    expect(mounted.host.querySelector('[data-agent-pane-tabs="right"] #agent-tab-two')?.getAttribute("draggable")).toBe("true");

    await dragTaskToLeft(mounted.host, "two");

    expect(dock.setActiveTaskId).toHaveBeenLastCalledWith("two");
    expect(mounted.host.querySelector('[data-agent-pane-tabs="right"]')).toBeNull();
    expect(mounted.host.querySelector("[data-agent-dock-toolbar] [role=tablist]")?.textContent).toContain("First task");
    expect(mounted.host.querySelector("[data-agent-dock-toolbar] [role=tablist]")?.textContent).toContain("Second task");
  });

  test("adds another tab to the right group without ejecting its existing tab", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
      { id: "three", label: "Third task", state: "running", provider: "claude" },
    ] });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");

    await dragTaskToSplit(mounted.host, "three");

    const right = mounted.host.querySelector('[data-agent-pane-tabs="right"]');
    expect(right?.textContent).toContain("Second task");
    expect(right?.textContent).toContain("Third task");
    expect(right?.querySelector("#agent-tab-three")?.getAttribute("aria-selected")).toBe("true");
    expect(mounted.host.querySelector('[data-agent-pane-tabs="left"]')?.textContent).toContain("First task");
  });

  test("shell mode opens a plain terminal with no prompt and no agent install", async () => {
    Object.assign(dock, { open: true, activeTaskId: "new", configured: false });
    dock.createShellTask.mockResolvedValue({ id: "sh1" });
    const { host } = await render();
    const run = host.querySelector('[aria-label="Run agent task"]') as HTMLButtonElement;
    expect(run.disabled).toBe(true);

    const shell = host.querySelector('[aria-label="Shell"]') as HTMLButtonElement;
    await act(async () => shell.click());

    // Missing agent is irrelevant to a shell, and an empty draft is valid.
    const open = host.querySelector('[aria-label="Open shell"]') as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    expect(host.querySelector('[aria-label="Shell command"]')).not.toBeNull();
    await act(async () => open.click());
    expect(dock.createShellTask).toHaveBeenCalledWith("");
    expect(dock.createTask).not.toHaveBeenCalled();
  });

  test("labels a shell tab by kind rather than an agent provider", async () => {
    Object.assign(dock, { open: true, activeTaskId: "sh1", tasks: [
      { id: "sh1", kind: "shell", state: "running" },
    ] });
    const { host } = await render();
    expect(host.textContent).toContain("Shell");
    // No agent capability chips against a plain shell.
    expect(host.querySelector('[aria-label="Agent provider"]')).toBeNull();
    expect(host.querySelector('[aria-label="Open task Shell"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Stop task Shell"]')).not.toBeNull();
  });

  test("renames a tab inline from double-click or F2", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "Original task", state: "running", provider: "claude" },
    ] });
    const { host } = await render();
    const tab = host.querySelector("#agent-tab-one") as HTMLButtonElement;

    await act(async () =>
      tab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    const input = host.querySelector(
      '[aria-label="Rename task Original task"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      input.value = "Renamed task";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(dock.renameTask).toHaveBeenCalledWith("one", "Renamed task");

    const restoredTab = host.querySelector("#agent-tab-one") as HTMLButtonElement;
    expect(document.activeElement).toBe(restoredTab);
    await act(async () =>
      restoredTab.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "F2" })),
    );
    const cancelled = host.querySelector(
      '[aria-label="Rename task Original task"]',
    ) as HTMLInputElement;
    await act(async () =>
      cancelled.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    expect(dock.renameTask).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(host.querySelector("#agent-tab-one"));
  });

  test("creates new sessions in the focused right tab group", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
    ] });
    dock.createShellTask.mockResolvedValue({ id: "three" });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");

    await act(async () =>
      (mounted.host.querySelector('[aria-label="Choose a new session"]') as HTMLButtonElement).click(),
    );
    await act(async () =>
      (document.body.querySelector('[role="menuitem"][aria-label="Shell"]') as HTMLButtonElement).click(),
    );

    expect(dock.createShellTask).toHaveBeenCalledWith(undefined, {
      background: true,
    });
  });

  test("composing keeps the split pane alive and takes the left half itself", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
    ] });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");

    dock.activeTaskId = "new";
    dock.draft = "Review both tasks";
    await rerender(mounted);

    const composer = mounted.host.querySelector("#agent-panel-new") as HTMLElement;
    expect(composer.style.right).toBe("50%");
    // The whole point: the task you split out stays readable while you type.
    const right = mounted.host.querySelector("#agent-panel-two") as HTMLElement;
    expect(right.style.left).toBe("50%");
    expect(right.className).not.toContain("invisible");
    expect(mounted.host.querySelector('[data-session="two"]')?.getAttribute("data-active")).toBe("true");
    expect((mounted.host.querySelector("#agent-panel-one") as HTMLElement).className).toContain("invisible");
  });

  test("switches the selected right tab without changing the left selection", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
      { id: "three", label: "Third task", state: "running", provider: "claude" },
    ] });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");
    await dragTaskToSplit(mounted.host, "three");

    act(() => (mounted.host.querySelector('[data-agent-pane-tabs="right"] [aria-label="Open task Second task"]') as HTMLButtonElement).click());

    expect((mounted.host.querySelector('#agent-panel-one') as HTMLElement).className).not.toContain("invisible");
    expect((mounted.host.querySelector('#agent-panel-two') as HTMLElement).className).not.toContain("invisible");
    expect((mounted.host.querySelector('#agent-panel-three') as HTMLElement).className).toContain("invisible");
    expect(mounted.host.querySelector('[data-agent-pane-tabs="right"]')).not.toBeNull();
  });

  test("resizes split panes by dragging the divider", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
    ] });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");

    const container = mounted.host.querySelector("[data-agent-split-container]") as HTMLElement;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 400, height: 400, left: 0, right: 1000, top: 0, width: 1000, x: 0, y: 0,
      toJSON: () => ({}),
    });
    const divider = mounted.host.querySelector('[aria-label="Resize split panes"]') as HTMLElement;
    await act(async () => {
      divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 500, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 700, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 700, pointerId: 1 }));
    });

    expect(divider.style.left).toBe("70%");
    expect((mounted.host.querySelector("#agent-panel-one") as HTMLElement).style.right).toBe("30%");
    expect((mounted.host.querySelector("#agent-panel-two") as HTMLElement).style.left).toBe("70%");
  });

  test("offers accessible task controls and maps viewport status", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [{ id: "one", label: "Run tests", state: "running", provider: "claude" }] });
    const { host } = await render();
    expect(host.querySelector('[aria-label="Choose a new session"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Stop task Run tests"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Close task Run tests"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Collapse agent terminal"]')).not.toBeNull();
    act(() => (host.querySelector("[data-session]") as HTMLButtonElement).click());
    expect(dock.updateTaskStatus).toHaveBeenCalledWith("one", { state: "running", cwd: "/repo", error: undefined });
    act(() => (host.querySelector('[aria-label="Stop task Run tests"]') as HTMLButtonElement).click());
    expect(dock.stopTask).toHaveBeenCalledWith("one");
  });

  test("expands to a full-screen terminal with horizontal navigation", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [{ id: "one", label: "Run tests", state: "running", provider: "claude" }] });
    const { host } = await render({ currentPage: "git", onNavigate: vi.fn() });

    act(() => (host.querySelector('[aria-label="Enter full-screen terminal"]') as HTMLButtonElement).click());

    expect(host.querySelector('[aria-label="Full-screen navigation"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Git Review"]')?.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector('[aria-label="Restore terminal dock"]')).not.toBeNull();
    expect(host.querySelector('[data-session="one"]')).not.toBeNull();
  });

  test("full-screen navigation opens the page and collapses the dock", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [{ id: "one", label: "Run tests", state: "running", provider: "claude" }] });
    const onNavigate = vi.fn();
    const { host } = await render({ currentPage: "services", onNavigate });
    act(() => (host.querySelector('[aria-label="Enter full-screen terminal"]') as HTMLButtonElement).click());
    act(() => (host.querySelector('[aria-label="Database"]') as HTMLButtonElement).click());

    expect(onNavigate).toHaveBeenCalledWith("database");
    expect(dock.setOpen).toHaveBeenCalledWith(false);
    expect(host.querySelector('[aria-label="Full-screen navigation"]')).toBeNull();
  });

  test("Escape restores the regular dock without closing it", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [{ id: "one", label: "Run tests", state: "running", provider: "claude" }] });
    const { host } = await render();
    act(() => (host.querySelector('[aria-label="Enter full-screen terminal"]') as HTMLButtonElement).click());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(host.querySelector('[aria-label="Full-screen navigation"]')).toBeNull();
    expect(dock.setOpen).not.toHaveBeenCalledWith(false);
    expect(host.querySelector('[data-session="one"]')).not.toBeNull();
  });

  test("clamps resize height to a usable band", () => {
    expect(clampAgentDockHeight(100, 900)).toBe(180);
    expect(clampAgentDockHeight(1000, 900)).toBe(852);
    expect(clampAgentDockHeight(450, 900)).toBe(450);
    expect(clampAgentDockHeight(180, 100)).toBe(52);
  });

  test("clamps side dock width while preserving room for the workbench", () => {
    expect(clampAgentDockWidth(200, 1440)).toBe(340);
    expect(clampAgentDockWidth(1400, 1440)).toBe(1120);
    expect(clampAgentDockWidth(520, 1440)).toBe(520);
    expect(clampAgentDockWidth(340, 500)).toBe(180);
  });

  test("renders the saved right-side layout and reports its workbench inset", async () => {
    Object.assign(dock, { open: true });
    uiSettings.ui.agentDockPlacement = "right";
    const onInsetChange = vi.fn();
    const { host } = await render({ onInsetChange });
    const panel = host.firstElementChild as HTMLElement;

    expect(panel.className).toContain("border-l");
    expect(panel.style.width).toBe("480px");
    expect(panel.querySelector('[data-agent-resize-grip]')?.className).toContain("cursor-ew-resize");
    expect(panel.querySelector('[data-agent-side-utilities]')).not.toBeNull();
    expect(onInsetChange).toHaveBeenLastCalledWith("right", 480);
  });

  test("opens the new-session menu downward from a right-side toolbar", async () => {
    Object.assign(dock, {
      open: true,
      activeTaskId: "one",
      tasks: [{ id: "one", label: "One", state: "running", provider: "claude" }],
    });
    uiSettings.ui.agentDockPlacement = "right";
    const { host } = await render();

    await act(async () =>
      (host.querySelector('[aria-label="Choose a new session"]') as HTMLButtonElement).click(),
    );
    const menu = document.body.querySelector(
      '[role="menu"][aria-label="Choose a new session"]',
    ) as HTMLElement;
    expect(menu.style.top).not.toBe("");
    expect(menu.style.bottom).toBe("");
  });

  test("uses a compact vertical rail when a right-side dock is collapsed", async () => {
    uiSettings.ui.agentDockPlacement = "right";
    const { host } = await render();
    const rail = host.querySelector('[aria-label="Open agent terminal"]') as HTMLButtonElement;

    expect(rail.className).toContain("w-9");
    expect(rail.className).toContain("border-l");
    expect(rail.querySelector('[class*="writing-mode"]')).not.toBeNull();
  });

  test("resizes a right-side dock by width", async () => {
    Object.assign(dock, { open: true });
    uiSettings.ui.agentDockPlacement = "right";
    const { host } = await render();
    const panel = host.firstElementChild as HTMLElement;
    const grip = host.querySelector('[data-agent-resize-grip]') as HTMLElement;

    act(() => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: window.innerWidth - 420,
      }));
    });
    expect(panel.style.width).toBe("420px");
  });

  test("temporarily falls back to the bottom without replacing a saved side preference", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    uiSettings.ui.agentDockPlacement = "right";
    const onInsetChange = vi.fn();
    const { host } = await render({ onInsetChange });
    const rail = host.querySelector('[aria-label="Open agent terminal"]') as HTMLButtonElement;

    expect(rail.className).toContain("inset-x-0");
    expect(onInsetChange).toHaveBeenLastCalledWith("bottom", 36);
    expect(uiSettings.updateUi).not.toHaveBeenCalled();
  });

  test("the position grip toggles and persists dock placement", async () => {
    Object.assign(dock, { open: true });
    const { host } = await render();
    const grip = host.querySelector('[aria-label="Drag to move dock"]') as HTMLButtonElement;

    act(() => grip.click());
    expect(uiSettings.updateUi).toHaveBeenCalledWith({ agentDockPlacement: "right" });
  });

  test("dragging the position grip to the right previews and persists the snap target", async () => {
    Object.assign(dock, { open: true });
    const { host } = await render();
    const grip = host.querySelector('[aria-label="Drag to move dock"]') as HTMLButtonElement;

    act(() => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: window.innerWidth - 10,
      }));
    });
    expect(host.textContent).toContain("Dock at right");

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", {
        pointerId: 1,
        clientX: window.innerWidth - 10,
      }));
      // Browsers emit a click after the pointer sequence. It must not toggle
      // the dock straight back to its previous position.
      grip.click();
    });
    expect(uiSettings.updateUi).toHaveBeenCalledWith({ agentDockPlacement: "right" });
    expect(uiSettings.updateUi).not.toHaveBeenCalledWith({ agentDockPlacement: "bottom" });
    expect(host.textContent).not.toContain("Dock at right");
  });

  test("double-clicking the resize grip resets the dock to 50vh", async () => {
    Object.assign(dock, { open: true }); const { host } = await render();
    const grip = host.querySelector('[data-agent-resize-grip]') as HTMLElement;
    act(() => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientY: 300 }));
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 200 }));
    });
    expect((host.firstElementChild as HTMLElement).style.height).not.toBe("50vh");
    act(() => grip.dispatchEvent(new Event("dblclick", { bubbles: true })));
    expect((host.firstElementChild as HTMLElement).style.height).toBe("50vh");
  });

  test("contains no legacy chat transcript presentation", async () => {
    Object.assign(dock, { open: true }); const { host } = await render();
    expect(host.querySelector(".chat-markdown,[data-approval],[data-response-card]")).toBeNull();
  });

  test("the app mounts the native terminal dock instead of the legacy chat dock", () => {
    const source = readFileSync("src/web/client/src/app.tsx", "utf8");
    expect(source).toContain("<AgentTerminalDock");
    expect(source).toContain("currentPage={page}");
    expect(source).toContain("onNavigate=");
    expect(source).not.toContain("<AgentDock");
  });

  test("disables missing providers and switches with the segmented control", async () => {
    Object.assign(dock, { open: true, activeTaskId: "new" }); const { host } = await render();
    const group = host.querySelector('[aria-label="Agent provider"]') as HTMLElement;
    const toggles = Array.from(group.querySelectorAll("button")) as HTMLButtonElement[];
    // Two agent providers plus Shell, which is never gated on an install.
    expect(toggles).toHaveLength(3);
    expect(toggles[0].getAttribute("aria-pressed")).toBe("true");
    expect(toggles[1].disabled).toBe(true);
    expect(toggles[1].title).toContain("npm i codex");
    expect(toggles[2].disabled).toBe(false);

    dock.providers[1].configured = true;
    const { host: enabledHost } = await render();
    const codex = enabledHost.querySelectorAll('[aria-label="Agent provider"] button')[1] as HTMLButtonElement;
    expect(codex.disabled).toBe(false);
    act(() => codex.click());
    expect(dock.selectProvider).toHaveBeenCalledWith("codex");
    dock.providers[1].configured = false;
  });
});
