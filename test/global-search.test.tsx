// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DashboardData } from "../src/web/client/src/lib/api/services-api";
import {
  GlobalSearch,
  shortcutLabel,
} from "../src/web/client/src/features/global-search/global-search";

const agent = vi.hoisted(() => ({
  setActiveTaskId: vi.fn(),
  setOpen: vi.fn(),
  tasks: [
    {
      id: "task-1",
      cwd: "/work/acme",
      cols: 80,
      rows: 24,
      shell: "zsh",
      state: "running",
      kind: "agent",
      provider: "codex",
      label: "Implement search",
    },
  ],
}));

vi.mock("../src/web/client/src/features/agent/chat/agent-context", () => ({
  useAgentDock: () => agent,
}));

const searchData = {
  ok: true,
  cwd: "/work/acme",
  config: {
    services: [],
    bundles: [],
    gitRepositories: [{ name: "acme", path: "/work/acme" }],
  },
  runtime: { services: {} },
  ports: [],
  health: {},
  timeline: [],
  logs: [],
  git: {
    cwd: "/work/acme",
    selectedRepository: { name: "acme", path: "/work/acme" },
    status: {
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [{ path: "src/global-search.tsx", index: " ", workingTree: "M" }],
    },
    branches: [{ name: "main", current: true, remote: false }],
  },
} satisfies DashboardData;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GlobalSearch", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onNavigate = vi.fn();
  const onOpenGit = vi.fn();
  const onOpenService = vi.fn();
  const onSelectProject = vi.fn(async () => undefined);

  async function renderSearch(data: DashboardData | null) {
    await act(async () => {
      root.render(
        <GlobalSearch
          data={data}
          onNavigate={onNavigate}
          onOpenGit={onOpenGit}
          onOpenService={onOpenService}
          onSelectProject={onSelectProject}
        />,
      );
    });
  }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await renderSearch(null);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  test("opens with the global shortcut and exposes combobox semantics", async () => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });
    const dialog = document.querySelector('[role="dialog"]');
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement;
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(input).toBe(document.activeElement);
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(1);
  });

  test("advertises the platform shortcut used by the handler", () => {
    expect(shortcutLabel("MacIntel")).toBe("⌘K");
    expect(shortcutLabel("Win32")).toBe("Ctrl K");
    expect(shortcutLabel("Linux x86_64")).toBe("Ctrl K");
  });

  test("filters results and activates the selected page with Enter", async () => {
    await act(async () => {
      (host.querySelector("button") as HTMLButtonElement).click();
    });
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement;
    await act(async () => setInputValue(input, "settings"));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith("settings");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("opens an active agent task from a search result", async () => {
    await act(async () => {
      (host.querySelector("button") as HTMLButtonElement).click();
    });
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement;
    await act(async () => setInputValue(input, "implement search"));
    const taskOption = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent?.includes("Implement search"),
    );
    expect(taskOption).toBeDefined();
    await act(async () => {
      taskOption?.click();
    });
    expect(agent.setActiveTaskId).toHaveBeenCalledWith("task-1");
    expect(agent.setOpen).toHaveBeenCalledWith(true);
  });

  test("routes changed files through the repository-scoped Git callback", async () => {
    await renderSearch(searchData);
    await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement;
    await act(async () => setInputValue(input, "global-search.tsx"));
    await act(async () => {
      (document.querySelector('[role="option"]') as HTMLButtonElement).click();
    });
    expect(onOpenGit).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalledWith("git");
  });

  test("keeps a reopened palette stable while project selection finishes", async () => {
    let finishProject: (() => void) | undefined;
    onSelectProject.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishProject = resolve;
      }),
    );
    await renderSearch(searchData);
    const trigger = host.querySelector("button") as HTMLButtonElement;
    await act(async () => trigger.click());
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement;
    await act(async () => setInputValue(input, "acme"));
    const project = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent?.includes("/work/acme"),
    );
    await act(async () => project?.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => trigger.click());
    expect(document.querySelector<HTMLButtonElement>('[role="option"]')?.disabled).toBe(true);

    await act(async () => finishProject?.());

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[role="option"]')?.disabled).toBe(false);
  });

  test("Escape closes and restores focus to the trigger", async () => {
    const trigger = host.querySelector("button") as HTMLButtonElement;
    trigger.focus();
    await act(async () => trigger.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
