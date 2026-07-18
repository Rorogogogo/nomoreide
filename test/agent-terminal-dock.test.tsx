// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dock = vi.hoisted(() => ({
  activeSource: null as null | { type: string; label: string }, activeTaskId: null as string | null,
  clearSource: vi.fn(), closeTask: vi.fn(), configured: true, createTask: vi.fn(), creating: 0,
  draft: "", focusNonce: 0, insertPath: vi.fn(), onboarding: false, open: false,
  provider: { id: "claude", label: "Claude Code", commandName: "claude", installHint: "", intro: "" },
  pendingTaskIds: new Set<string>(),
  providers: [
    { id: "claude", label: "Claude Code", commandName: "claude", installHint: "", intro: "", configured: true },
    { id: "codex", label: "Codex", commandName: "codex", installHint: "npm i codex", intro: "", configured: false },
  ],
  selectProvider: vi.fn(), setActiveTaskId: vi.fn(), setDraft: vi.fn(), setOnboarding: vi.fn(),
  setOpen: vi.fn(), stopTask: vi.fn(), tasks: [] as Array<Record<string, unknown>>,
  terminalError: null as string | null, updateTaskStatus: vi.fn(),
}));

vi.mock("@/features/agent/chat/agent-context", () => ({ useAgentDock: () => dock }));
vi.mock("@/features/terminal/terminal-viewport", () => ({
  TerminalViewport: ({ sessionId, active, onStatusChange }: { sessionId: string; active: boolean; onStatusChange: (s: unknown) => void }) =>
    <button data-active={String(active)} data-session={sessionId} onClick={() => onStatusChange({ state: "running", cwd: "/repo", detail: "claude" })}>viewport</button>,
}));
vi.mock("@/features/agent/chat/file-picker", () => ({ FilePicker: () => null }));
vi.mock("@/features/git/git-situation-banner", () => ({ GitSituationBanner: () => null }));

import { AgentTerminalDock, clampAgentDockHeight } from "../src/web/client/src/features/agent/terminal/agent-terminal-dock";

async function render(props: ComponentProps<typeof AgentTerminalDock> = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); await act(async () => root.render(<AgentTerminalDock {...props} />));
  return { host, root };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); document.body.replaceChildren();
  Object.assign(dock, { activeSource: null, activeTaskId: null, configured: true, creating: 0, draft: "", focusNonce: 0, onboarding: false, open: false, pendingTaskIds: new Set(), tasks: [], terminalError: null });
});
afterEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = false; });

describe("AgentTerminalDock", () => {
  test("renders a 36px collapsed task rail and expands from the whole rail", async () => {
    const { host } = await render();
    const rail = host.querySelector('[aria-label="Open agent terminal"]') as HTMLButtonElement;
    expect(rail.className).toContain("h-9"); expect(host.textContent).toContain("New agent task");
    act(() => rail.click()); expect(dock.setOpen).toHaveBeenCalledWith(true);
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

  test("opens the composer from plus and when a staged draft arrives", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [{ id: "one", label: "One", state: "running" }] });
    const mounted = await render();
    expect(mounted.host.querySelector('[aria-label="Agent task prompt"]')).toBeNull();
    await act(async () => (mounted.host.querySelector('[aria-label="New agent task"]') as HTMLButtonElement).click());
    expect(mounted.host.querySelector('[aria-label="Agent task prompt"]')).not.toBeNull();
    await act(async () => mounted.root.unmount());
    Object.assign(dock, { draft: "staged", focusNonce: 2 });
    const staged = await render();
    expect((staged.host.querySelector('[aria-label="Agent task prompt"]') as HTMLTextAreaElement).value).toBe("staged");
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
    await act(async () => mounted.root.render(<AgentTerminalDock />));

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

  test("offers accessible task controls and maps viewport status", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [{ id: "one", label: "Run tests", state: "running", provider: "claude" }] });
    const { host } = await render();
    expect(host.querySelector('[aria-label="New agent task"]')).not.toBeNull();
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

  test("disables missing providers and selects an installed provider", async () => {
    Object.assign(dock, { open: true }); const { host } = await render();
    const select = host.querySelector('[aria-label="Agent provider"]') as HTMLSelectElement;
    expect((select.querySelector('option[value="codex"]') as HTMLOptionElement).disabled).toBe(true);
    dock.providers[1].configured = true;
    select.value = "codex";
    act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(dock.selectProvider).toHaveBeenCalledWith("codex");
    dock.providers[1].configured = false;
  });
});
