// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dock = vi.hoisted(() => ({
  activeSource: null as null | { type: string; label: string }, activeTaskId: null as string | null,
  claimInitialInput: vi.fn(), clearOneTimeSkill: vi.fn(), clearSource: vi.fn(), closeTask: vi.fn(), configured: true,
  consumeOneTimeSkill: vi.fn(),
  createShellTask: vi.fn(), createTask: vi.fn(), creating: 0,
  dockLayout: {
    version: 1 as const,
    open: false,
    bottomHeight: null as number | null,
    rightWidth: 480,
    splitPercent: 50,
    rightTaskIds: [] as string[],
    activeLeftTaskId: null as string | null,
    activeRightTaskId: null as string | null,
    focusedPane: "left" as "left" | "right",
    historyRailOpen: false,
  },
  draft: "", focusNonce: 0, insertPath: vi.fn(), onboarding: false, open: false,
  foregroundAgentDeliveryHandler: null as null | ((delivery: { label?: string; prompt: string; source?: { type: string; label: string } }) => "draft" | "handled"),
  loadTranscripts: vi.fn(),
  models: {} as Partial<Record<"claude" | "codex", string>>,
  selectModel: vi.fn(),
  provider: { id: "claude", label: "Claude Code", commandName: "claude", installHint: "", intro: "" },
  pendingTaskIds: new Set<string>(),
  pendingOneTimeSkill: null as null | { name: string; source: string },
  providers: [
    { id: "claude", label: "Claude Code", commandName: "claude", installHint: "", intro: "", configured: true },
    { id: "codex", label: "Codex", commandName: "codex", installHint: "npm i codex", intro: "", configured: false },
  ],
  // Selection lives in the provider, so the mock must actually hold it — the
  // dock reads it back to decide whether the compose tab is the current one.
  selectProvider: vi.fn(), setActiveTaskId: vi.fn((id: string | null) => { dock.activeTaskId = id; }),
  selectOneTimeSkill: vi.fn(),
  setDraft: vi.fn(), setOnboarding: vi.fn(),
  renameTask: vi.fn(),
  registerForegroundAgentDeliveryHandler: vi.fn((handler: (delivery: { label?: string; prompt: string; source?: { type: string; label: string } }) => "draft" | "handled") => {
    dock.foregroundAgentDeliveryHandler = handler;
    return () => {
      if (dock.foregroundAgentDeliveryHandler === handler) {
        dock.foregroundAgentDeliveryHandler = null;
      }
    };
  }),
  resumeTask: vi.fn(),
  sendToAgent: vi.fn(),
  setOpen: vi.fn(), stopTask: vi.fn(), tasks: [] as Array<Record<string, unknown>>,
  tasksHydrated: true,
  tasksHydrationSettled: true,
  terminalError: null as string | null,
  transcripts: [] as Array<Record<string, unknown>>,
  transcriptsError: null as string | null,
  transcriptsLoading: false,
  updateDockLayout: vi.fn(),
  updateTaskStatus: vi.fn(),
}));
const uiSettings = vi.hoisted(() => ({
  confirmedGlobal: { terminal: undefined },
  ui: { agentDockPlacement: "bottom" as "bottom" | "right" },
  updateUi: vi.fn(),
}));
const skillPromptApi = vi.hoisted(() => ({
  load: vi.fn(),
}));
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
const terminalHandle = vi.hoisted(() => ({
  focus: vi.fn(),
  input: vi.fn(),
  paste: vi.fn(() => true),
  refit: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("@/features/agent/chat/agent-context", () => ({ useAgentDock: () => dock }));
vi.mock("@/components/ui/toast", () => ({ useToasts: () => toast }));
vi.mock("@/lib/api", () => ({
  getAgentEnvConfigs: vi.fn().mockResolvedValue([]),
  getAgentInfo: vi.fn().mockResolvedValue(null),
  getAgentUsage: vi.fn().mockResolvedValue({}),
  getMcpAuthStatuses: vi.fn().mockResolvedValue([]),
  loadOneTimeSkillPrompt: skillPromptApi.load,
}));
vi.mock("@/features/settings/settings-context", () => ({
  useOptionalSettings: () => uiSettings,
}));
vi.mock("@/features/terminal/terminal-viewport", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    TerminalViewport: forwardRef(function MockTerminalViewport(
      { sessionId, active, onStatusChange }: {
        sessionId: string;
        active: boolean;
        onStatusChange: (s: unknown) => void;
      },
      ref,
    ) {
      useImperativeHandle(ref, () => terminalHandle);
      return <button data-active={String(active)} data-session={sessionId} onClick={() => onStatusChange({ state: "running", cwd: "/repo", detail: "claude" })}>viewport</button>;
    }),
  };
});
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

async function unmountMounted(mounted: {
  host: HTMLElement;
  root: ReturnType<typeof createRoot>;
}) {
  await act(async () => mounted.root.unmount());
  mountedRoots = mountedRoots.filter((root) => root !== mounted.root);
  mounted.host.remove();
}

function domRect(left: number, top: number, width: number, height: number) {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top,
  } as DOMRect;
}

/**
 * Reveal the conversation rail. The toggle writes through `updateDockLayout`,
 * which the mock applies to a plain object React cannot observe — so the
 * re-render that a real provider would trigger is done by hand.
 */
async function openHistoryRail(mounted: {
  host: HTMLElement;
  root: ReturnType<typeof createRoot>;
}) {
  await act(async () =>
    (mounted.host.querySelector(
      '[aria-label="Open conversation history"]',
    ) as HTMLButtonElement).click(),
  );
  await rerender(mounted);
  return mounted.host.querySelector("[data-agent-history-rail]") as HTMLElement;
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
  Object.assign(dock, { activeSource: null, activeTaskId: null, configured: true, creating: 0, draft: "", focusNonce: 0, foregroundAgentDeliveryHandler: null, onboarding: false, open: false, pendingOneTimeSkill: null, pendingTaskIds: new Set(), tasks: [], terminalError: null });
  dock.dockLayout = {
    version: 1,
    open: false,
    bottomHeight: null,
    rightWidth: 480,
    splitPercent: 50,
    rightTaskIds: [],
    activeLeftTaskId: null,
    activeRightTaskId: null,
    focusedPane: "left",
    historyRailOpen: false,
  };
  dock.tasksHydrated = true;
  dock.tasksHydrationSettled = true;
  dock.updateDockLayout.mockImplementation((patch) => {
    Object.assign(dock.dockLayout, patch);
  });
  Object.assign(dock, { transcripts: [], transcriptsError: null, transcriptsLoading: false });
  dock.loadTranscripts.mockResolvedValue([]);
  dock.closeTask.mockResolvedValue(true);
  skillPromptApi.load.mockResolvedValue("skill context\n");
});
afterEach(async () => {
  const roots = mountedRoots; mountedRoots = [];
  await act(async () => { for (const root of roots) root.unmount(); });
  vi.restoreAllMocks();
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

  test("collapsed rail keeps the latest task status after the task is gone", async () => {
    Object.assign(dock, {
      activeTaskId: "latest",
      tasks: [{ id: "latest", label: "Review changes", state: "exited", provider: "codex" }],
    });
    const mounted = await render();
    expect(mounted.host.textContent).toContain("Review changes");
    expect(mounted.host.textContent).toContain("Exited");

    Object.assign(dock, { activeTaskId: null, tasks: [] });
    await rerender(mounted);

    expect(mounted.host.textContent).toContain("Codex");
    expect(mounted.host.textContent).toContain("Review changes");
    expect(mounted.host.textContent).toContain("Latest task status: Exited");
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

  test("opens a new agent task with an empty prompt", async () => {
    Object.assign(dock, { open: true, draft: "" });
    dock.createTask.mockResolvedValue({ id: "new" });
    const { host } = await render();

    const run = host.querySelector('[aria-label="Run agent task"]') as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    await act(async () => run.click());

    expect(dock.createTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "",
      label: "Agent task",
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

  test("attaches and consumes a temporary skill only after successful submit", async () => {
    const skill = {
      name: "find-skills",
      source: "vercel-labs/skills@find-skills",
    };
    Object.assign(dock, {
      open: true,
      draft: "Find a testing skill",
      pendingOneTimeSkill: skill,
    });
    dock.createTask.mockResolvedValue({ id: "new" });
    const { host } = await render();

    expect(host.textContent).toContain("find-skills");
    expect(host.textContent).toContain("Attached to this prompt only");
    await act(async () =>
      (host.querySelector('[aria-label="Run agent task"]') as HTMLButtonElement).click(),
    );

    expect(dock.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ oneTimeSkill: skill, prompt: "Find a testing skill" }),
    );
    expect(dock.consumeOneTimeSkill).toHaveBeenCalledWith(skill);
  });

  test("retains a temporary skill and draft when fresh task creation fails", async () => {
    const skill = { name: "review", source: "owner/repo@review" };
    Object.assign(dock, {
      open: true,
      draft: "Review this",
      pendingOneTimeSkill: skill,
    });
    dock.createTask.mockResolvedValue(undefined);
    const { host } = await render();

    await act(async () =>
      (host.querySelector('[aria-label="Run agent task"]') as HTMLButtonElement).click(),
    );

    expect(dock.consumeOneTimeSkill).not.toHaveBeenCalled();
    expect(dock.setDraft).not.toHaveBeenCalledWith("");
    expect(dock.clearOneTimeSkill).not.toHaveBeenCalled();
  });

  test("pastes a one-time skill into the active agent prompt without submitting it", async () => {
    const skill = { name: "review", source: "owner/repo@review" };
    Object.assign(dock, {
      activeTaskId: "active",
      open: true,
      pendingOneTimeSkill: skill,
      tasks: [
        {
          id: "active",
          kind: "agent",
          label: "Active",
          provider: "claude",
          state: "running",
        },
      ],
    });
    const { host } = await render();
    await act(async () => {});

    expect(skillPromptApi.load).toHaveBeenCalledWith(skill);
    expect(terminalHandle.paste).toHaveBeenCalledWith(
      "skill context\n\nUser's request:\n",
      "Skill: review ",
    );
    expect(terminalHandle.input).not.toHaveBeenCalled();
    expect(dock.consumeOneTimeSkill).toHaveBeenCalledWith(skill);
    expect(dock.createTask).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Agent task prompt"]')).toBeNull();
  });

  test("retains a retryable active attachment when resolving a skill fails", async () => {
    const skill = { name: "review", source: "owner/repo@review" };
    Object.assign(dock, {
      activeTaskId: "active",
      open: true,
      pendingOneTimeSkill: skill,
      tasks: [
        {
          id: "active",
          kind: "agent",
          label: "Active",
          provider: "codex",
          state: "running",
        },
      ],
    });
    skillPromptApi.load.mockRejectedValue(new Error("Skill unavailable"));
    const { host } = await render();
    await act(async () => {});

    expect(host.textContent).toContain("Skill unavailable");
    expect(host.querySelector('[data-one-time-skill-status]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Retry adding skill"]')).not.toBeNull();
    expect(terminalHandle.paste).not.toHaveBeenCalled();
    expect(dock.consumeOneTimeSkill).not.toHaveBeenCalled();
  });

  test("reveals the conversation rail and resumes a selected session", async () => {
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
    const mounted = await render();

    const rail = await openHistoryRail(mounted);
    expect(rail).not.toBeNull();
    expect(dock.updateDockLayout).toHaveBeenCalledWith({ historyRailOpen: true });
    expect(dock.loadTranscripts).toHaveBeenCalledWith("all");
    expect(rail.textContent).toContain("Finish conversation management");

    await act(async () =>
      (Array.from(rail.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Finish conversation management"),
      ) as HTMLButtonElement).click(),
    );
    expect(dock.resumeTask).toHaveBeenCalledWith(transcript);
    // A column rail is part of the layout, so resuming leaves it in place —
    // unlike the overlay below, which is covering the session it hands back to.
    expect(mounted.host.querySelector("[data-agent-history-rail]")).not.toBeNull();
  });

  test("floats the rail over the session when the dock is too narrow to seat it", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(560);
    Object.assign(dock, { open: true });
    const mounted = await render();

    const rail = await openHistoryRail(mounted);
    expect(rail.className).toContain("absolute");

    // The rail carries no close button, so an overlay sitting over a session is
    // dismissed with Escape — or by the toolbar toggle that opened it.
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(dock.updateDockLayout).toHaveBeenLastCalledWith({
      historyRailOpen: false,
    });
  });

  test("seats the rail as a column when the dock is wide enough", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1200);
    Object.assign(dock, { open: true });
    const mounted = await render();

    const rail = await openHistoryRail(mounted);
    expect(rail.className).not.toContain("absolute");
    expect(rail.className).toContain("border-r");
  });

  // The rail is only ever shown beside the composer, so a "new session" row
  // would duplicate the surface it sits next to, and a close button would
  // duplicate the toolbar toggle that reveals it.
  test("gives the rail no new-session row and no close button", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1200);
    Object.assign(dock, { open: true });
    const mounted = await render();

    const rail = await openHistoryRail(mounted);
    const labels = Array.from(rail.querySelectorAll("button")).map(
      (button) => `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`,
    );
    expect(labels.some((label) => /new session/i.test(label))).toBe(false);
    expect(labels.some((label) => /hide conversation history/i.test(label))).toBe(false);
  });

  test("groups conversation rows under recency headings, newest bucket first", async () => {
    // Calendar days, not elapsed hours: a session from earlier today and one
    // from late yesterday can be hours apart yet must land in different groups.
    const now = new Date("2026-07-25T09:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const dayBefore = (days: number) =>
      new Date(now.getTime() - days * 86_400_000).toISOString();
    Object.assign(dock, {
      open: true,
      transcripts: [
        { id: "a", provider: "claude", cwd: "/repo", title: "Ship the rail", startedAt: dayBefore(0), updatedAt: dayBefore(0) },
        { id: "b", provider: "claude", cwd: "/repo", title: "Chase a flake", startedAt: dayBefore(1), updatedAt: dayBefore(1) },
        { id: "c", provider: "claude", cwd: "/repo", title: "Read the logs", startedAt: dayBefore(5), updatedAt: dayBefore(5) },
        { id: "d", provider: "claude", cwd: "/repo", title: "Ancient thread", startedAt: dayBefore(90), updatedAt: dayBefore(90) },
      ],
    });
    try {
      const mounted = await render();
      const rail = await openHistoryRail(mounted);
      const headings = Array.from(
        rail.querySelectorAll("[data-conversation-scroll] h3"),
      ).map((heading) => heading.textContent);
      expect(headings).toEqual(["Today", "Yesterday", "Previous 7 days", "Older"]);
      // Each row belongs to the heading above it, so the row order has to
      // follow the bucket order rather than the raw transcript order.
      const rows = Array.from(
        rail.querySelectorAll("[data-conversation-scroll] button"),
      ).map((row) => row.textContent ?? "");
      expect(rows).toEqual([
        "Ship the rail",
        "Chase a flake",
        "Read the logs",
        "Ancient thread",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("lists both providers together, newest first, and searches across them", async () => {
    // One list, both agents: recency is what makes a thread findable, so a
    // Codex session more recent than a Claude one sorts above it rather than
    // living behind a provider tab.
    Object.assign(dock, {
      open: true,
      transcripts: [
        {
          id: "codex-session",
          provider: "codex",
          cwd: "/repo",
          title: "Polish the dock history",
          startedAt: "2026-07-24T01:00:00.000Z",
          updatedAt: "2026-07-25T01:00:00.000Z",
        },
        {
          id: "claude-session",
          provider: "claude",
          cwd: "/repo",
          title: "Investigate flaky checkout",
          startedAt: "2026-07-23T01:00:00.000Z",
          updatedAt: "2026-07-24T01:00:00.000Z",
        },
      ],
    });
    const mounted = await render();

    const rail = await openHistoryRail(mounted);
    const scrollRegion = rail.querySelector("[data-conversation-scroll]");
    expect(scrollRegion?.className).toContain("overflow-y-auto");
    expect(rail.textContent).toContain("Investigate flaky checkout");
    expect(rail.textContent).toContain("Polish the dock history");
    expect(dock.loadTranscripts).toHaveBeenLastCalledWith("all");
    // Neither filter survives — the rail shows the latest sessions, full stop.
    expect(document.body.querySelector('[aria-label="Conversation project scope"]')).toBeNull();
    expect(
      document.body.querySelector('[aria-label="Filter conversations by provider"]'),
    ).toBeNull();

    // Search still reaches the provider name, which is how you narrow to one
    // agent now that the tabs are gone.
    const search = document.body.querySelector(
      '[aria-label="Search conversations"]',
    ) as HTMLInputElement;
    await act(async () => {
      search.value = "codex";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Polish the dock history");
    expect(document.body.textContent).not.toContain("Investigate flaky checkout");

    await act(async () => {
      search.value = "flaky";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Investigate flaky checkout");
    expect(document.body.textContent).not.toContain("Polish the dock history");
  });

  test("renders every row when a provider repeats a session id", async () => {
    // Codex reuses one session id across the rollout files it writes for a
    // conversation's subagents. The listing collapses those, but a repeated id
    // must not collapse React rows either — a bare id as the key silently drops
    // all but one of them.
    const codexRow = (suffix: string) => ({
      id: "shared-codex-id",
      provider: "codex",
      cwd: "/repo",
      title: `Codex thread ${suffix}`,
      startedAt: "2026-07-24T01:00:00.000Z",
      updatedAt: `2026-07-25T0${suffix}:00:00.000Z`,
    });
    Object.assign(dock, {
      open: true,
      transcripts: [codexRow("1"), codexRow("2"), codexRow("3")],
    });
    const mounted = await render();

    const rail = await openHistoryRail(mounted);
    const rows = Array.from(
      // Rows sit under their recency heading, so this reaches past the group
      // wrappers rather than assuming they are direct children.
      rail.querySelectorAll("[data-conversation-scroll] button"),
    ).map((row) => row.textContent ?? "");
    expect(rows).toEqual([
      "Codex thread 1",
      "Codex thread 2",
      "Codex thread 3",
    ]);
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

  test("shows the agent logo wave while a session is starting", async () => {
    Object.assign(dock, { open: true, configured: true, creating: 1 });
    const { host } = await render();
    const status = host.querySelector('[role="status"]');

    expect(status?.getAttribute("aria-label")).toBe("Starting Claude Code…");
    expect(status?.querySelectorAll(".agent-wave-mark")).toHaveLength(5);
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

  test("inserts a foreground send into the only visible running agent", async () => {
    Object.assign(dock, {
      open: true,
      activeTaskId: "one",
      tasks: [
        { id: "one", kind: "agent", label: "First task", state: "running", provider: "claude" },
        { id: "two", kind: "agent", label: "Hidden task", state: "running", provider: "codex" },
      ],
    });
    await render();

    let result: "draft" | "handled" = "draft";
    await act(async () => {
      result = dock.foregroundAgentDeliveryHandler?.({ prompt: "Review this change" }) ?? "draft";
    });

    expect(result).toBe("handled");
    expect(terminalHandle.paste).toHaveBeenCalledWith("Review this change");
    expect(terminalHandle.focus).toHaveBeenCalled();
    expect(dock.createTask).not.toHaveBeenCalled();
  });

  test("reopens a collapsed running agent and inserts the foreground send", async () => {
    Object.assign(dock, {
      open: false,
      activeTaskId: "one",
      tasks: [{ id: "one", kind: "agent", label: "Hidden task", state: "running", provider: "claude" }],
    });
    await render();

    expect(dock.foregroundAgentDeliveryHandler?.({ prompt: "Continue here" })).toBe("handled");
    expect(dock.setOpen).toHaveBeenCalledWith(true);
    expect(terminalHandle.paste).toHaveBeenCalledWith("Continue here");
    expect(dock.createTask).not.toHaveBeenCalled();
  });

  test("routes a foreground send to the composer when there are no running agents", async () => {
    Object.assign(dock, { open: false, activeTaskId: null, tasks: [] });
    await render();

    expect(dock.foregroundAgentDeliveryHandler?.({ prompt: "Start fresh" })).toBe("draft");
    expect(dock.setOpen).not.toHaveBeenCalled();
    expect(terminalHandle.paste).not.toHaveBeenCalled();
  });

  test("asks which visible split agent should receive a foreground send", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", kind: "agent", label: "First task", state: "running", provider: "claude" },
      { id: "two", kind: "agent", label: "Second task", state: "running", provider: "codex" },
    ] });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");

    await act(async () => {
      expect(dock.foregroundAgentDeliveryHandler?.({ prompt: "Review this split" })).toBe("handled");
    });

    expect(terminalHandle.paste).not.toHaveBeenCalled();
    expect(mounted.host.querySelectorAll("[data-agent-delivery-target]")).toHaveLength(2);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Insert into Claude Code");
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(mounted.host.querySelectorAll("[data-agent-delivery-target]")).toHaveLength(0);

    await act(async () => {
      dock.foregroundAgentDeliveryHandler?.({ prompt: "Review this split" });
    });
    const codexTarget = mounted.host.querySelector(
      '[aria-label="Insert into Codex"]',
    ) as HTMLButtonElement;

    await act(async () => codexTarget.click());

    expect(terminalHandle.paste).toHaveBeenCalledWith("Review this split");
    expect(mounted.host.querySelectorAll("[data-agent-delivery-target]")).toHaveLength(0);
  });

  test("reopens a collapsed split and asks which agent should receive the send", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", kind: "agent", label: "First task", state: "running", provider: "claude" },
      { id: "two", kind: "agent", label: "Second task", state: "running", provider: "codex" },
    ] });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");
    dock.open = false;
    await rerender(mounted);

    await act(async () => {
      expect(dock.foregroundAgentDeliveryHandler?.({ prompt: "Choose after opening" })).toBe("handled");
    });

    expect(dock.setOpen).toHaveBeenCalledWith(true);
    expect(dock.createTask).not.toHaveBeenCalled();
    expect(terminalHandle.paste).not.toHaveBeenCalled();

    dock.open = true;
    await rerender(mounted);
    expect(mounted.host.querySelectorAll("[data-agent-delivery-target]")).toHaveLength(2);
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
    expect(host.querySelectorAll("[data-agent-dock-toolbar] [role=tablist]")).toHaveLength(2);
    expect(host.querySelector("[data-agent-split-container] [role=tablist]")).toBeNull();
    const leftHeader = host.querySelector('[data-agent-pane-tabs="left"]') as HTMLElement;
    const rightHeader = host.querySelector('[data-agent-pane-tabs="right"]') as HTMLElement;
    expect(leftHeader.textContent).toContain("First task");
    expect(rightHeader.textContent).toContain("Second task");
    expect(leftHeader.style.right).toBe("50%");
    expect(rightHeader.style.left).toBe("50%");
    expect(leftHeader.className).not.toContain("overflow-hidden");
    expect(rightHeader.className).not.toContain("overflow-hidden");
    expect(host.querySelector('[data-agent-pane-tabs="left"] [aria-label="Claude Code capabilities"]')).not.toBeNull();
    expect(host.querySelector('[data-agent-pane-tabs="right"] [aria-label="Codex capabilities"]')).not.toBeNull();

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

  test("composing takes the whole dock and restores the saved split afterward", async () => {
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
    expect(composer.className).toContain("inset-x-0");
    expect(composer.style.right).toBe("");
    const right = mounted.host.querySelector("#agent-panel-two") as HTMLElement;
    expect(right.className).toContain("invisible");
    expect(mounted.host.querySelector('[data-session="two"]')?.getAttribute("data-active")).toBe("false");
    expect((mounted.host.querySelector("#agent-panel-one") as HTMLElement).className).toContain("invisible");
    expect(mounted.host.querySelector('[aria-label="Resize split panes"]')).toBeNull();
    expect(mounted.host.querySelector('[data-agent-pane-tabs="left"]')).not.toBeNull();
    expect(mounted.host.querySelector('[data-agent-pane-tabs="right"]')).not.toBeNull();
    expect(mounted.host.querySelector("#agent-tab-new")).toBeNull();

    await act(async () =>
      (mounted.host.querySelector('[aria-label="Open task Second task"]') as HTMLButtonElement).click(),
    );
    await rerender(mounted);

    expect((mounted.host.querySelector("#agent-panel-one") as HTMLElement).className).not.toContain("invisible");
    expect((mounted.host.querySelector("#agent-panel-two") as HTMLElement).className).not.toContain("invisible");
    expect((mounted.host.querySelector("#agent-panel-two") as HTMLElement).style.left).toBe("50%");
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

  test("restores resized and split layout after a remount", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [
      { id: "one", label: "First task", state: "running", provider: "claude" },
      { id: "two", label: "Second task", state: "running", provider: "codex" },
    ] });
    const mounted = await render();
    const panel = mounted.host.firstElementChild as HTMLElement;
    const resizeGrip = mounted.host.querySelector(
      "[data-agent-resize-grip]",
    ) as HTMLElement;
    await act(async () => {
      resizeGrip.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 1,
          clientY: window.innerHeight - 420,
        }),
      );
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });
    expect(panel.style.height).toBe("420px");

    await dragTaskToSplit(mounted.host, "two");
    const container = mounted.host.querySelector(
      "[data-agent-split-container]",
    ) as HTMLElement;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
      domRect(0, 0, 1_000, 400),
    );
    const divider = mounted.host.querySelector(
      '[aria-label="Resize split panes"]',
    ) as HTMLElement;
    await act(async () => {
      divider.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: 500,
          pointerId: 2,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 700,
          pointerId: 2,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { clientX: 700, pointerId: 2 }),
      );
    });

    await unmountMounted(mounted);
    const restored = await render();
    const restoredDivider = restored.host.querySelector(
      '[aria-label="Resize split panes"]',
    ) as HTMLElement;
    expect((restored.host.firstElementChild as HTMLElement).style.height).toBe(
      "420px",
    );
    expect(restoredDivider.getAttribute("aria-valuenow")).toBe("70");
    expect(
      restored.host.querySelector('[data-agent-pane-tabs="right"] #agent-tab-two'),
    ).not.toBeNull();
  });

  test("keeps pane changes made while session hydration is pending", async () => {
    Object.assign(dock, {
      open: true,
      activeTaskId: "one",
      tasksHydrated: false,
      tasksHydrationSettled: false,
      tasks: [
        { id: "one", label: "First task", state: "running", provider: "claude" },
        { id: "two", label: "Second task", state: "running", provider: "codex" },
      ],
    });
    const mounted = await render();
    await dragTaskToSplit(mounted.host, "two");
    expect(
      mounted.host.querySelector('[data-agent-pane-tabs="right"] #agent-tab-two'),
    ).not.toBeNull();

    dock.tasksHydrated = true;
    dock.tasksHydrationSettled = true;
    await rerender(mounted);

    expect(
      mounted.host.querySelector('[data-agent-pane-tabs="right"] #agent-tab-two'),
    ).not.toBeNull();
    expect(dock.dockLayout.rightTaskIds).toEqual(["two"]);
  });

  test("persists live pane changes after session hydration fails", async () => {
    Object.assign(dock, {
      open: true,
      activeTaskId: "one",
      tasksHydrated: false,
      tasksHydrationSettled: true,
      tasks: [
        { id: "one", label: "First task", state: "running", provider: "claude" },
        { id: "two", label: "Second task", state: "running", provider: "codex" },
      ],
    });
    dock.dockLayout.rightTaskIds = ["saved-session"];
    const mounted = await render();
    expect(dock.dockLayout.rightTaskIds).toEqual(["saved-session"]);

    await dragTaskToSplit(mounted.host, "two");

    expect(dock.dockLayout.rightTaskIds).toEqual(["two"]);
  });

  test("restores independent bottom and right dock dimensions", async () => {
    Object.assign(dock, {
      open: true,
      dockLayout: {
        ...dock.dockLayout,
        bottomHeight: 410,
        rightWidth: 620,
      },
    });
    const bottom = await render();
    expect((bottom.host.firstElementChild as HTMLElement).style.height).toBe(
      "410px",
    );
    await unmountMounted(bottom);

    uiSettings.ui.agentDockPlacement = "right";
    const right = await render();
    expect((right.host.firstElementChild as HTMLElement).style.width).toBe(
      "620px",
    );
  });

  test("offers accessible task controls and maps viewport status", async () => {
    Object.assign(dock, { open: true, activeTaskId: "one", tasks: [{ id: "one", label: "Run tests", state: "running", provider: "claude" }] });
    const { host } = await render();
    // Closing the tab is the only way to end a session — the toolbar carries no
    // separate stop control.
    expect(host.querySelector('[aria-label="Stop task Run tests"]')).toBeNull();
    expect(host.querySelector('[aria-label="Close task Run tests"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Collapse agent terminal"]')).not.toBeNull();
    act(() => (host.querySelector("[data-session]") as HTMLButtonElement).click());
    expect(dock.updateTaskStatus).toHaveBeenCalledWith("one", { state: "running", cwd: "/repo", error: undefined });
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
    expect(clampAgentDockHeight(1000, 900)).toBe(630);
    expect(clampAgentDockHeight(450, 900)).toBe(450);
    expect(clampAgentDockHeight(180, 100)).toBe(52);
  });

  test("clamps side dock width while preserving room for the workbench", () => {
    expect(clampAgentDockWidth(200, 1440)).toBe(340);
    expect(clampAgentDockWidth(1400, 1440)).toBe(1008);
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
    expect(onInsetChange).toHaveBeenLastCalledWith("right", 480, false);
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
    const onInsetChange = vi.fn();
    const { host } = await render({ onInsetChange });
    const panel = host.firstElementChild as HTMLElement;
    const grip = host.querySelector('[data-agent-resize-grip]') as HTMLElement;

    await act(async () => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: window.innerWidth - 420,
      }));
    });
    expect(panel.style.width).toBe("420px");
    expect(onInsetChange).toHaveBeenLastCalledWith("right", 420, true);

    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });
    expect(onInsetChange).toHaveBeenLastCalledWith("right", 420, false);
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
    expect(onInsetChange).toHaveBeenLastCalledWith("bottom", 36, false);
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
