// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperationProvider } from "../src/web/client/src/components/operations/operation-context";
import { SettingsView } from "../src/web/client/src/features/settings/settings-view";
import type { SettingsContextValue } from "../src/web/client/src/features/settings/settings-context";

const settings = vi.hoisted(() => ({ current: null as SettingsContextValue | null }));

vi.mock("@/features/settings/settings-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/settings/settings-context")>();
  return {
    ...actual,
    useSettings: () => {
      if (!settings.current) throw new Error("missing test settings");
      return settings.current;
    },
  };
});

const baseSettings: SettingsContextValue = {
  loading: false,
  loadError: null,
  activeProjectPath: "/tmp/workbench",
  projectLoading: false,
  projectLoadError: null,
  selectProject: vi.fn(async () => undefined),
  retryProject: vi.fn(async () => undefined),
  retry: vi.fn(async () => undefined),
  saveState: "idle",
  saveError: null,
  global: {
    version: 1,
    terminal: {
      fontSize: 13,
      cursorStyle: "block",
      scrollback: 5_000,
      copyOnSelect: false,
      confirmTerminate: true,
    },
  },
  confirmedGlobal: {
    version: 1,
    terminal: {
      fontSize: 13,
      cursorStyle: "block",
      scrollback: 5_000,
      copyOnSelect: false,
      confirmTerminate: true,
    },
  },
  project: {
    logs: { showTimestamps: true, wrapLines: true },
    database: { confirmWrites: true, resultLimit: 100 },
  },
  confirmedProject: {
    logs: { showTimestamps: true, wrapLines: true },
    database: { confirmWrites: true, resultLimit: 100 },
  },
  ui: {
    version: 1,
    theme: "system",
    language: "en",
    density: "comfortable",
    codeFontSize: 12,
    reducedMotion: false,
    sidebarDocked: false,
    projectScope: "all",
  },
  updateGlobal: vi.fn(async () => undefined),
  updateProject: vi.fn(async () => undefined),
  updateUi: vi.fn(() => true),
  resetGlobal: vi.fn(async () => undefined),
  resetProject: vi.fn(async () => undefined),
  resetUi: vi.fn(),
};

let root: Root;
let host: HTMLDivElement;

async function renderView(
  props: Partial<React.ComponentProps<typeof SettingsView>> = {},
  value: Partial<SettingsContextValue> = {},
) {
  settings.current = { ...baseSettings, ...value };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <OperationProvider>
        <SettingsView
          activeProject={{ name: "Workbench", path: "/tmp/workbench" }}
          {...props}
        />
      </OperationProvider>,
    );
  });
}

function button(name: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  if (!match) throw new Error(`button not found: ${name}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function typeInto(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setValue?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  settings.current = null;
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  document.body.replaceChildren();
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("SettingsView", () => {
  test("shows all ten stable categories in the desktop navigation", async () => {
    await renderView();

    const nav = host.querySelector('[aria-label="Settings categories"]');
    expect(nav).not.toBeNull();
    expect([...nav!.querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual([
      "General",
      "Appearance",
      "Terminal",
      "Services & Logs",
      "Git & GitHub",
      "Agents & MCP",
      "Database & Safety",
      "Notifications",
      "Data & Privacy",
      "About",
    ]);
  });

  test("selects a category and marks only its navigation tab current", async () => {
    await renderView();

    await click(button("Terminal"));

    expect(host.querySelector("main h2")?.textContent).toBe("Terminal");
    expect(button("Terminal").getAttribute("aria-current")).toBe("page");
    expect(button("General").hasAttribute("aria-current")).toBe(false);
  });

  test("searches labels, descriptions, and category keywords without changing selection", async () => {
    await renderView();
    await click(button("Terminal"));
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;

    await typeInto(search, "danger confirmation");

    expect(host.textContent).toContain("Confirm before writes");
    expect(host.textContent).toContain("Search results");
    expect(host.textContent).toContain("Global");
    expect(host.textContent).toContain("Current project");
    expect(button("Terminal").getAttribute("aria-current")).toBe("page");

    await click(button("Clear settings search"));
    expect(host.querySelector("main h2")?.textContent).toBe("Terminal");
    expect(search.value).toBe("");
  });

  test("searches every setting description rather than a hard-coded subset", async () => {
    await renderView();
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;

    await typeInto(search, "expanded");

    expect(host.textContent).toContain("Search results");
    expect(host.textContent).toContain("Dock sidebar");
  });

  test("shows only the matching terminal row for an individual setting query", async () => {
    await renderView();
    await typeInto(host.querySelector<HTMLInputElement>('input[type="search"]')!, "clipboard");

    expect(host.textContent).toContain("Copy on select");
    expect(host.textContent).not.toContain("Terminal font size");
    expect(host.textContent).not.toContain("Cursor style");
    expect(host.textContent).not.toContain("Scrollback limit");
    expect(host.textContent).not.toContain("Confirm before terminating");
  });

  test("shows only the matching database row for an individual description query", async () => {
    await renderView();
    await typeInto(host.querySelector<HTMLInputElement>('input[type="search"]')!, "submitted");

    expect(host.textContent).toContain("Confirm before writes");
    expect(host.textContent).not.toContain("Default result limit");
    expect(host.textContent).not.toContain("Connections");
  });

  test.each([
    ["explicit", "Theme"],
    ["throughout", "Interface density"],
    ["horizontally", "Wrap log lines"],
    ["submitted", "Confirm before writes"],
    ["workbench", "Connections"],
    ["supported", "Desktop notifications"],
    ["arrive", "Desktop notifications"],
  ])("finds the visible description term %s", async (term, label) => {
    await renderView();
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;

    await typeInto(search, term);

    expect(host.textContent).toContain("Search results");
    expect(host.textContent).toContain(label);
  });

  test("disables project settings with a visible reason when no project is active", async () => {
    await renderView({ activeProject: null });
    await click(button("Services & Logs"));

    expect(host.textContent).toContain("Select a project to change project settings.");
    const timestamps = host.querySelector<HTMLInputElement>('#setting-log-timestamps');
    expect(timestamps?.disabled).toBe(true);
  });

  test("shows the active project name and editable project controls", async () => {
    await renderView();
    await click(button("Database & Safety"));

    expect(host.textContent).toContain("Workbench");
    expect(host.textContent).toContain("nomoreide.config.json");
    expect(host.querySelector<HTMLInputElement>('#setting-confirm-writes')?.disabled).toBe(false);
  });

  test("keeps project controls disabled while provider data belongs to another project", async () => {
    await renderView({}, { activeProjectPath: "/tmp/previous", projectLoading: true });
    await click(button("Database & Safety"));

    expect(host.querySelector<HTMLInputElement>('#setting-confirm-writes')?.disabled).toBe(true);
    expect(host.textContent).toContain("Loading settings for Workbench");
  });

  test("keeps global controls usable while a project error is retried inline", async () => {
    const retryProject = vi.fn(async () => undefined);
    await renderView({}, {
      projectLoadError: "project config is invalid",
      retryProject,
    });

    expect(host.querySelector<HTMLSelectElement>("#setting-language")?.disabled).toBe(false);
    expect(host.textContent).not.toContain("Settings could not be loaded");
    await click(button("Services & Logs"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("project config is invalid");
    expect(host.querySelector<HTMLInputElement>("#setting-log-timestamps")?.disabled).toBe(true);
    await click(button("Retry project settings"));
    expect(retryProject).toHaveBeenCalledOnce();
  });

  test("supports ArrowUp, ArrowDown, Home, and End category navigation", async () => {
    await renderView();
    const general = button("General");
    general.focus();

    await act(async () => general.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(button("Appearance"));
    expect(host.querySelector("main h2")?.textContent).toBe("Appearance");

    await act(async () => button("Appearance").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(button("About"));
    await act(async () => button("About").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(document.activeElement).toBe(button("Data & Privacy"));
    await act(async () => button("Data & Privacy").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(button("General"));
  });

  test("uses a single tab stop for desktop category navigation", async () => {
    await renderView();
    expect(button("General").tabIndex).toBe(0);
    expect(button("Appearance").tabIndex).toBe(-1);

    await click(button("Terminal"));
    expect(button("General").tabIndex).toBe(-1);
    expect(button("Terminal").tabIndex).toBe(0);
  });

  test("provides a labeled narrow-layout category select", async () => {
    await renderView();
    const select = host.querySelector<HTMLSelectElement>('#settings-category-select');
    expect(select).not.toBeNull();
    expect(host.querySelector(`label[for="${select?.id}"]`)?.textContent).toContain("Category");
    expect(select?.options).toHaveLength(10);
  });

  test("renders stable loading rows and a load error with retry", async () => {
    await renderView({}, { loading: true });
    expect(host.querySelector('[aria-label="Loading settings"]')?.children.length).toBeGreaterThanOrEqual(3);

    await act(async () => root.unmount());
    host.remove();
    const retry = vi.fn(async () => undefined);
    await renderView({}, { loadError: "daemon unavailable", retry });
    expect(host.textContent).toContain("daemon unavailable");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("daemon unavailable");
    await click(button("Retry"));
    expect(retry).toHaveBeenCalledOnce();
  });

  test.each([
    ["saving", "Saving…"],
    ["saved", "Saved"],
    ["error", "Could not save global settings"],
  ] as const)("shows %s save status", async (saveState, text) => {
    await renderView({}, {
      saveState,
      saveError: saveState === "error" ? "Could not save global settings" : null,
    });
    expect(host.textContent).toContain(text);
  });

  test("binds real controls with labels and descriptions to provider updates", async () => {
    const updateUi = vi.fn(() => true);
    const updateGlobal = vi.fn(async () => undefined);
    await renderView({}, { updateUi, updateGlobal });

    const sidebar = host.querySelector<HTMLInputElement>('#setting-sidebar-docked')!;
    expect(host.querySelector(`label[for="${sidebar.id}"]`)?.textContent).toContain("Dock sidebar");
    expect(document.getElementById(`${sidebar.id}-description`)?.textContent).toContain("expanded");
    await click(sidebar);
    expect(updateUi).toHaveBeenCalledWith({ sidebarDocked: true });

    await click(button("Terminal"));
    const copy = host.querySelector<HTMLInputElement>('#setting-copy-on-select')!;
    await click(copy);
    expect(updateGlobal).toHaveBeenCalledWith({ terminal: { copyOnSelect: true } });
  });

  test("validates numeric settings before explicit save", async () => {
    const updateGlobal = vi.fn(async () => undefined);
    await renderView({}, { updateGlobal });
    await click(button("Terminal"));
    const scrollback = host.querySelector<HTMLInputElement>('#setting-scrollback')!;

    await typeInto(scrollback, "0");
    await click(button("Save Scrollback limit"));
    expect(updateGlobal).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Enter a value from 500 to 100000");

    await typeInto(scrollback, "8000");
    await click(button("Save Scrollback limit"));
    expect(updateGlobal).toHaveBeenCalledWith({ terminal: { scrollback: 8000 } });
  });

  test("groups mixed categories by scope and keeps unsupported features noninteractive", async () => {
    await renderView({ onNavigate: vi.fn() });
    await click(button("Git & GitHub"));
    expect([...host.querySelectorAll("h3")].map((item) => item.textContent)).toEqual(
      expect.arrayContaining(["Global", "Current project"]),
    );

    await click(button("Data & Privacy"));
    expect(host.textContent).toContain("Export and reset controls are coming in a later delivery.");
    expect([...host.querySelectorAll("button")].some((item) => /export|reset/i.test(item.textContent ?? ""))).toBe(false);
  });
});
