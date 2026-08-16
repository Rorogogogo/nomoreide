// @vitest-environment happy-dom

import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SettingsProvider,
  useSettings,
  type SettingsContextValue,
} from "../src/web/client/src/features/settings/settings-context";
import {
  loadUiPreferences,
  resetUiPreferences,
  UI_PREFERENCES_KEY,
} from "../src/web/client/src/features/settings/ui-preferences";

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  resetGlobalSettings: vi.fn(),
  resetProjectSettings: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

const initialSnapshot = {
  global: {
    version: 1 as const,
    terminal: {
      fontSize: 13,
      cursorStyle: "block" as const,
      scrollback: 5_000,
      copyOnSelect: false,
      confirmTerminate: true,
    },
  },
  project: {
    logs: { showTimestamps: true, wrapLines: true },
    database: { confirmWrites: true, resultLimit: 100 },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Capture({ onValue }: { onValue: (value: SettingsContextValue) => void }) {
  const value = useSettings();
  useEffect(() => onValue(value), [onValue, value]);
  return null;
}

async function mountProvider(strict = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let current: SettingsContextValue | undefined;
  await act(async () => {
    const tree = (
      <SettingsProvider>
        <Capture onValue={(value) => { current = value; }} />
      </SettingsProvider>
    );
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  return {
    get value() {
      if (!current) throw new Error("provider has not rendered");
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
  window.localStorage.clear();
  api.getSettings.mockResolvedValue(structuredClone(initialSnapshot));
  api.updateGlobalSettings.mockImplementation(async () => structuredClone(initialSnapshot.global));
  api.updateProjectSettings.mockImplementation(async () => structuredClone(initialSnapshot.project));
  api.resetGlobalSettings.mockResolvedValue(structuredClone(initialSnapshot.global));
  api.resetProjectSettings.mockResolvedValue(structuredClone(initialSnapshot.project));
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("UI preference migration", () => {
  test("migrates legacy theme, language, sidebar, and project scope into one versioned document", () => {
    window.localStorage.setItem("nomoreide-theme-choice", "light");
    window.localStorage.setItem("nomoreide-language", "zh");
    window.localStorage.setItem("nomoreide:sidebar-docked", "true");
    window.localStorage.setItem("nomoreide:project-scope", "project");

    const preferences = loadUiPreferences();

    expect(preferences).toMatchObject({
      version: 4,
      theme: "light",
      language: "zh",
      density: "comfortable",
      codeFontSize: 12,
      sidebarDocked: true,
      agentDockPlacement: "bottom",
      projectScope: "project",
    });
    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "null")).toEqual(
      preferences,
    );
  });

  test("falls back safely from a corrupt document while keeping valid legacy pieces", () => {
    window.localStorage.setItem(UI_PREFERENCES_KEY, "{not-json");
    window.localStorage.setItem("nomoreide-theme-choice", "neon");
    window.localStorage.setItem("nomoreide-language-choice", "zh");
    window.localStorage.setItem("nomoreide:sidebar-docked", "not-a-boolean");
    window.localStorage.setItem("nomoreide:project-scope", "project");

    expect(loadUiPreferences()).toMatchObject({
      version: 4,
      theme: "system",
      language: "zh",
      sidebarDocked: false,
      agentDockPlacement: "bottom",
      projectScope: "project",
    });
  });

  test("rejects invalid fields in a new document", () => {
    window.localStorage.setItem(
      UI_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        theme: "neon",
        language: "xx",
        density: "tiny",
        codeFontSize: 30,
        reducedMotion: "yes",
        sidebarDocked: "yes",
        agentDockPlacement: "left",
        projectScope: "workspace",
      }),
    );

    expect(loadUiPreferences()).toMatchObject({
      theme: "system",
      language: "en",
      density: "comfortable",
      codeFontSize: 12,
      sidebarDocked: false,
      agentDockPlacement: "bottom",
      projectScope: "all",
    });
  });

  test("uses defaults when localStorage reads throw and still lets the provider mount", async () => {
    const getItem = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("storage denied");
      });
    try {
      expect(loadUiPreferences()).toMatchObject({
        version: 4,
        theme: "system",
        language: "en",
        sidebarDocked: false,
        agentDockPlacement: "bottom",
        projectScope: "all",
      });
      const mounted = await mountProvider();
      expect(mounted.value.ui.theme).toBe("system");
      await unmount(mounted.root, mounted.host);
    } finally {
      getItem.mockRestore();
    }
  });
});

describe("SettingsProvider", () => {
  test("loads independent preferences when the selected project changes", async () => {
    const mounted = await mountProvider();
    api.getSettings.mockImplementation(async (path?: string) => ({
      ...structuredClone(initialSnapshot),
      project: {
        ...structuredClone(initialSnapshot.project),
        database: {
          ...initialSnapshot.project.database,
          resultLimit: path === "/work/a" ? 111 : 222,
        },
      },
    }));

    await act(async () => mounted.value.selectProject("/work/a"));
    expect(mounted.value.activeProjectPath).toBe("/work/a");
    expect(mounted.value.project.database.resultLimit).toBe(111);

    await act(async () => mounted.value.selectProject("/work/b"));
    expect(mounted.value.activeProjectPath).toBe("/work/b");
    expect(mounted.value.project.database.resultLimit).toBe(222);
    expect(api.getSettings).toHaveBeenNthCalledWith(2, "/work/a");
    expect(api.getSettings).toHaveBeenNthCalledWith(3, "/work/b");
    await unmount(mounted.root, mounted.host);
  });

  test("ignores a stale project response after a rapid project switch", async () => {
    const mounted = await mountProvider();
    const projectA = deferred<typeof initialSnapshot>();
    const projectB = deferred<typeof initialSnapshot>();
    api.getSettings
      .mockReturnValueOnce(projectA.promise)
      .mockReturnValueOnce(projectB.promise);

    let selectA!: Promise<void>;
    let selectB!: Promise<void>;
    act(() => { selectA = mounted.value.selectProject("/work/a"); });
    act(() => { selectB = mounted.value.selectProject("/work/b"); });
    projectB.resolve({
      ...initialSnapshot,
      project: { ...initialSnapshot.project, database: { confirmWrites: true, resultLimit: 222 } },
    });
    await act(async () => selectB);
    projectA.resolve({
      ...initialSnapshot,
      project: { ...initialSnapshot.project, database: { confirmWrites: true, resultLimit: 111 } },
    });
    await act(async () => selectA);

    expect(mounted.value.activeProjectPath).toBe("/work/b");
    expect(mounted.value.project.database.resultLimit).toBe(222);
    expect(mounted.value.projectLoading).toBe(false);
    await unmount(mounted.root, mounted.host);
  });

  test("does not let an older project selection overwrite a newer retry", async () => {
    const mounted = await mountProvider();
    const selection = deferred<typeof initialSnapshot>();
    const retry = deferred<typeof initialSnapshot>();
    api.getSettings
      .mockReturnValueOnce(selection.promise)
      .mockReturnValueOnce(retry.promise);

    let selectionOperation!: Promise<void>;
    let retryOperation!: Promise<void>;
    act(() => { selectionOperation = mounted.value.selectProject("/work/a"); });
    act(() => { retryOperation = mounted.value.retry(); });
    retry.resolve({
      ...initialSnapshot,
      project: { ...initialSnapshot.project, database: { confirmWrites: true, resultLimit: 222 } },
    });
    await act(async () => retryOperation);
    selection.resolve({
      ...initialSnapshot,
      project: { ...initialSnapshot.project, database: { confirmWrites: true, resultLimit: 111 } },
    });
    await act(async () => selectionOperation);

    expect(mounted.value.project.database.resultLimit).toBe(222);
    await unmount(mounted.root, mounted.host);
  });

  test("ignores a failed retry after another project has loaded", async () => {
    const mounted = await mountProvider();
    await act(async () => mounted.value.selectProject("/work/a"));
    const retryA = deferred<typeof initialSnapshot>();
    api.getSettings.mockReturnValueOnce(retryA.promise).mockResolvedValueOnce({
      ...initialSnapshot,
      project: {
        ...initialSnapshot.project,
        database: { confirmWrites: true, resultLimit: 222 },
      },
    });

    let retryOperation!: Promise<void>;
    act(() => { retryOperation = mounted.value.retry(); });
    await act(async () => Promise.resolve());
    await act(async () => mounted.value.selectProject("/work/b"));
    retryA.reject(new Error("project A disappeared"));
    await act(async () => retryOperation);

    expect(mounted.value.loadError).toBeNull();
    expect(mounted.value.activeProjectPath).toBe("/work/b");
    expect(mounted.value.project.database.resultLimit).toBe(222);
    expect(mounted.value.projectLoading).toBe(false);
    await unmount(mounted.root, mounted.host);
  });

  test("captures the project path for a save and never leaks its result after switching", async () => {
    const mounted = await mountProvider();
    api.getSettings.mockImplementation(async (path?: string) => ({
      ...initialSnapshot,
      project: {
        ...initialSnapshot.project,
        database: { confirmWrites: true, resultLimit: path === "/work/b" ? 222 : 111 },
      },
    }));
    await act(async () => mounted.value.selectProject("/work/a"));
    const saveA = deferred<typeof initialSnapshot.project>();
    api.updateProjectSettings.mockReturnValueOnce(saveA.promise);

    let save!: Promise<void>;
    let selectB!: Promise<void>;
    act(() => { save = mounted.value.updateProject({ logs: { wrapLines: false } }); });
    act(() => { selectB = mounted.value.selectProject("/work/b"); });
    saveA.resolve({ ...initialSnapshot.project, logs: { showTimestamps: true, wrapLines: false } });
    await act(async () => Promise.all([save, selectB]));

    expect(api.updateProjectSettings).toHaveBeenCalledWith("/work/a", { logs: { wrapLines: false } });
    expect(mounted.value.activeProjectPath).toBe("/work/b");
    expect(mounted.value.project.database.resultLimit).toBe(222);
    expect(mounted.value.project.logs.wrapLines).toBe(true);
    await unmount(mounted.root, mounted.host);
  });

  test("waits for a queued save before reloading A after an A to B to A switch", async () => {
    const mounted = await mountProvider();
    await act(async () => mounted.value.selectProject("/work/a"));
    const saveA = deferred<typeof initialSnapshot.project>();
    api.updateProjectSettings.mockReturnValueOnce(saveA.promise);
    api.getSettings.mockClear();
    api.getSettings.mockImplementation(async (path?: string) => ({
      ...initialSnapshot,
      project: {
        ...initialSnapshot.project,
        logs: { showTimestamps: true, wrapLines: path === "/work/a" ? false : true },
      },
    }));

    let save!: Promise<void>;
    let selectB!: Promise<void>;
    let selectA!: Promise<void>;
    act(() => { save = mounted.value.updateProject({ logs: { wrapLines: false } }); });
    await act(async () => Promise.resolve());
    act(() => { selectB = mounted.value.selectProject("/work/b"); });
    act(() => { selectA = mounted.value.selectProject("/work/a"); });
    await act(async () => Promise.resolve());
    expect(api.getSettings).not.toHaveBeenCalled();

    saveA.resolve({ ...initialSnapshot.project, logs: { showTimestamps: true, wrapLines: false } });
    await act(async () => Promise.all([save, selectB, selectA]));

    expect(mounted.value.activeProjectPath).toBe("/work/a");
    expect(mounted.value.project.logs.wrapLines).toBe(false);
    await unmount(mounted.root, mounted.host);
  });

  test("rolls a failed queued patch back to the preceding successful patch", async () => {
    const mounted = await mountProvider();
    await act(async () => mounted.value.selectProject("/work/a"));
    const first = deferred<typeof initialSnapshot.project>();
    const second = deferred<typeof initialSnapshot.project>();
    api.updateProjectSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    let firstOperation!: Promise<void>;
    let secondOperation!: Promise<void>;
    act(() => {
      firstOperation = mounted.value.updateProject({ logs: { wrapLines: false } });
      secondOperation = mounted.value.updateProject({ database: { resultLimit: 250 } });
    });
    first.resolve({
      ...initialSnapshot.project,
      logs: { showTimestamps: true, wrapLines: false },
    });
    await act(async () => firstOperation);
    second.reject(new Error("project config is read-only"));
    await act(async () => secondOperation);

    expect(mounted.value.project.logs.wrapLines).toBe(false);
    expect(mounted.value.confirmedProject.logs.wrapLines).toBe(false);
    expect(mounted.value.project.database.resultLimit).toBe(100);
    await unmount(mounted.root, mounted.host);
  });

  test("keeps a project load failure separate and retries only that project", async () => {
    const mounted = await mountProvider();
    api.getSettings.mockRejectedValueOnce(new Error("project config is invalid"));

    await act(async () => mounted.value.selectProject("/work/a"));
    expect(mounted.value.loadError).toBeNull();
    expect(mounted.value.projectLoadError).toContain("project config is invalid");

    api.getSettings.mockResolvedValueOnce({
      ...initialSnapshot,
      project: { ...initialSnapshot.project, database: { confirmWrites: true, resultLimit: 321 } },
    });
    await act(async () => mounted.value.retryProject());

    expect(mounted.value.projectLoadError).toBeNull();
    expect(mounted.value.project.database.resultLimit).toBe(321);
    expect(mounted.value.activeProjectPath).toBe("/work/a");
    await unmount(mounted.root, mounted.host);
  });

  test("blocks project mutations until a project is selected", async () => {
    const mounted = await mountProvider();

    await act(async () => mounted.value.updateProject({ logs: { wrapLines: false } }));

    expect(api.updateProjectSettings).not.toHaveBeenCalled();
    expect(mounted.value.saveState).toBe("error");
    expect(mounted.value.saveError).toContain("Select a project");
    await unmount(mounted.root, mounted.host);
  });

  test("blocks project reset until a project is selected", async () => {
    const mounted = await mountProvider();

    await act(async () => mounted.value.resetProject());

    expect(api.resetProjectSettings).not.toHaveBeenCalled();
    expect(mounted.value.saveState).toBe("error");
    expect(mounted.value.saveError).toContain("Select a project");
    await unmount(mounted.root, mounted.host);
  });

  test("loads the API snapshot once under React StrictMode", async () => {
    const mounted = await mountProvider(true);

    expect(api.getSettings).toHaveBeenCalledOnce();
    expect(mounted.value.loading).toBe(false);
    await unmount(mounted.root, mounted.host);
  });

  test("does not let the initial GET overwrite a newer global save", async () => {
    const load = deferred<typeof initialSnapshot>();
    api.getSettings.mockReturnValue(load.promise);
    api.updateGlobalSettings.mockResolvedValue({
      ...initialSnapshot.global,
      terminal: { ...initialSnapshot.global.terminal, fontSize: 16 },
    });
    const mounted = await mountProvider();

    await act(async () => {
      await mounted.value.updateGlobal({ terminal: { fontSize: 16 } });
    });
    load.resolve({
      global: initialSnapshot.global,
      project: {
        ...initialSnapshot.project,
        database: { ...initialSnapshot.project.database, resultLimit: 250 },
      },
    });
    await act(async () => load.promise);

    expect(mounted.value.global.terminal.fontSize).toBe(16);
    expect(mounted.value.confirmedGlobal.terminal.fontSize).toBe(16);
    expect(mounted.value.project.database.resultLimit).toBe(250);
    expect(mounted.value.confirmedProject.database.resultLimit).toBe(250);
    await unmount(mounted.root, mounted.host);
  });

  test("does not let a manual retry overwrite a newer project save", async () => {
    const mounted = await mountProvider();
    await act(async () => mounted.value.selectProject("/work/a"));
    const retryLoad = deferred<typeof initialSnapshot>();
    api.getSettings.mockReturnValueOnce(retryLoad.promise);
    api.updateProjectSettings.mockResolvedValue({
      ...initialSnapshot.project,
      logs: { ...initialSnapshot.project.logs, wrapLines: false },
    });

    let retryOperation!: Promise<void>;
    act(() => {
      retryOperation = mounted.value.retry();
    });
    await act(async () => {
      await mounted.value.updateProject({ logs: { wrapLines: false } });
    });
    retryLoad.resolve({
      global: {
        ...initialSnapshot.global,
        terminal: { ...initialSnapshot.global.terminal, fontSize: 18 },
      },
      project: initialSnapshot.project,
    });
    await act(async () => retryOperation);

    expect(mounted.value.project.logs.wrapLines).toBe(false);
    expect(mounted.value.confirmedProject.logs.wrapLines).toBe(false);
    expect(mounted.value.global.terminal.fontSize).toBe(18);
    expect(mounted.value.confirmedGlobal.terminal.fontSize).toBe(18);
    await unmount(mounted.root, mounted.host);
  });

  test("ignores a retry response after unmount", async () => {
    const mounted = await mountProvider();
    const retryLoad = deferred<typeof initialSnapshot>();
    api.getSettings.mockReturnValueOnce(retryLoad.promise);
    let retryOperation!: Promise<void>;
    act(() => {
      retryOperation = mounted.value.retry();
    });
    const rendered = mounted.value;
    await unmount(mounted.root, mounted.host);

    retryLoad.resolve({
      ...initialSnapshot,
      global: {
        ...initialSnapshot.global,
        terminal: { ...initialSnapshot.global.terminal, fontSize: 18 },
      },
    });
    await act(async () => retryOperation);

    expect(rendered.global.terminal.fontSize).toBe(13);
  });

  test("optimistically updates global settings then keeps the confirmed server snapshot", async () => {
    const save = deferred<typeof initialSnapshot.global>();
    api.updateGlobalSettings.mockReturnValue(save.promise);
    const mounted = await mountProvider();

    let operation!: Promise<void>;
    act(() => {
      operation = mounted.value.updateGlobal({ terminal: { fontSize: 15 } });
    });
    expect(mounted.value.global.terminal.fontSize).toBe(15);
    expect(mounted.value.confirmedGlobal.terminal.fontSize).toBe(13);
    expect(mounted.value.saveState).toBe("saving");

    save.resolve({ ...initialSnapshot.global, terminal: { ...initialSnapshot.global.terminal, fontSize: 16 } });
    await act(async () => operation);

    expect(mounted.value.global.terminal.fontSize).toBe(16);
    expect(mounted.value.confirmedGlobal.terminal.fontSize).toBe(16);
    expect(mounted.value.saveState).toBe("saved");
    await unmount(mounted.root, mounted.host);
  });

  test("rolls a failed optimistic update back and exposes an actionable error", async () => {
    api.updateGlobalSettings.mockRejectedValue(new Error("settings file is read-only"));
    const mounted = await mountProvider();

    await act(async () => {
      await mounted.value.updateGlobal({ terminal: { fontSize: 15 } });
    });

    expect(mounted.value.global.terminal.fontSize).toBe(13);
    expect(mounted.value.confirmedGlobal.terminal.fontSize).toBe(13);
    expect(mounted.value.saveState).toBe("error");
    expect(mounted.value.saveError).toContain("settings file is read-only");
    await unmount(mounted.root, mounted.host);
  });

  test("keeps global and project updates isolated", async () => {
    api.updateProjectSettings.mockResolvedValue({
      ...initialSnapshot.project,
      logs: { showTimestamps: true, wrapLines: false },
    });
    const mounted = await mountProvider();
    await act(async () => mounted.value.selectProject("/work/a"));

    await act(async () => {
      await mounted.value.updateProject({ logs: { wrapLines: false } });
    });

    expect(mounted.value.project.logs.wrapLines).toBe(false);
    expect(mounted.value.global).toEqual(initialSnapshot.global);
    expect(mounted.value.confirmedGlobal).toEqual(initialSnapshot.global);
    await unmount(mounted.root, mounted.host);
  });

  test("resets only the requested server scope and resets UI preferences locally", async () => {
    window.localStorage.setItem("nomoreide-theme-choice", "light");
    const mounted = await mountProvider();
    await act(async () => mounted.value.selectProject("/work/a"));
    await act(async () => {
      mounted.value.updateUi({ density: "compact", sidebarDocked: true });
    });

    await act(async () => mounted.value.resetProject());
    expect(api.resetProjectSettings).toHaveBeenCalledWith("/work/a");
    expect(api.resetGlobalSettings).not.toHaveBeenCalled();
    expect(mounted.value.ui.density).toBe("compact");

    act(() => mounted.value.resetUi());
    expect(mounted.value.ui).toEqual(resetUiPreferences());
    expect(api.resetProjectSettings).toHaveBeenCalledOnce();
    expect(api.resetGlobalSettings).not.toHaveBeenCalled();
    await unmount(mounted.root, mounted.host);
  });

  test("rejects invalid UI patches without changing attributes or persisted preferences", async () => {
    const mounted = await mountProvider();
    act(() => {
      mounted.value.updateUi({ codeFontSize: 14, density: "compact" });
    });
    const persisted = window.localStorage.getItem(UI_PREFERENCES_KEY);

    let accepted: boolean | undefined;
    act(() => {
      accepted = mounted.value.updateUi({ codeFontSize: 100 });
    });

    expect(accepted).toBe(false);
    expect(mounted.value.ui.codeFontSize).toBe(14);
    expect(document.documentElement.style.getPropertyValue("--code-font-size")).toBe(
      "14px",
    );
    expect(window.localStorage.getItem(UI_PREFERENCES_KEY)).toBe(persisted);
    await unmount(mounted.root, mounted.host);
  });

  test("tracks system theme media changes and removes the listener for an explicit theme", async () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const addEventListener = vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    );
    const removeEventListener = vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    );
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener,
          removeEventListener,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    window.localStorage.setItem(
      UI_PREFERENCES_KEY,
      JSON.stringify({ ...resetUiPreferences(), theme: "system" }),
    );
    const mounted = await mountProvider();

    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    expect(addEventListener).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => {
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "null").theme).toBe(
      "system",
    );

    act(() => {
      mounted.value.updateUi({ theme: "light" });
    });
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    act(() => {
      mounted.value.updateUi({ theme: "system" });
    });
    expect(addEventListener).toHaveBeenCalledTimes(2);
    await unmount(mounted.root, mounted.host);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  test("stays saving until concurrent global and project saves have both settled", async () => {
    const globalSave = deferred<typeof initialSnapshot.global>();
    const projectSave = deferred<typeof initialSnapshot.project>();
    api.updateGlobalSettings.mockReturnValue(globalSave.promise);
    api.updateProjectSettings.mockReturnValue(projectSave.promise);
    const mounted = await mountProvider();
    await act(async () => mounted.value.selectProject("/work/a"));

    let globalOperation!: Promise<void>;
    let projectOperation!: Promise<void>;
    act(() => {
      globalOperation = mounted.value.updateGlobal({ terminal: { fontSize: 14 } });
      projectOperation = mounted.value.updateProject({ logs: { wrapLines: false } });
    });
    await act(async () => Promise.resolve());
    expect(mounted.value.saveState).toBe("saving");

    globalSave.resolve({
      ...initialSnapshot.global,
      terminal: { ...initialSnapshot.global.terminal, fontSize: 14 },
    });
    await act(async () => globalOperation);
    expect(mounted.value.saveState).toBe("saving");

    projectSave.resolve({
      ...initialSnapshot.project,
      logs: { ...initialSnapshot.project.logs, wrapLines: false },
    });
    await act(async () => projectOperation);
    expect(mounted.value.saveState).toBe("saved");
    await unmount(mounted.root, mounted.host);
  });

  test("does not let an overlapping success hide another scope's failure", async () => {
    const globalSave = deferred<typeof initialSnapshot.global>();
    const projectSave = deferred<typeof initialSnapshot.project>();
    api.updateGlobalSettings.mockReturnValue(globalSave.promise);
    api.updateProjectSettings.mockReturnValue(projectSave.promise);
    const mounted = await mountProvider();
    await act(async () => mounted.value.selectProject("/work/a"));

    let globalOperation!: Promise<void>;
    let projectOperation!: Promise<void>;
    act(() => {
      globalOperation = mounted.value.updateGlobal({ terminal: { fontSize: 14 } });
      projectOperation = mounted.value.updateProject({ logs: { wrapLines: false } });
    });
    projectSave.reject(new Error("project config is read-only"));
    await act(async () => projectOperation);
    expect(mounted.value.saveState).toBe("saving");

    globalSave.resolve({
      ...initialSnapshot.global,
      terminal: { ...initialSnapshot.global.terminal, fontSize: 14 },
    });
    await act(async () => globalOperation);
    expect(mounted.value.saveState).toBe("error");
    expect(mounted.value.saveError).toContain("project config is read-only");
    await unmount(mounted.root, mounted.host);
  });

  test("serializes overlapping mutations so an older response cannot overwrite newer state", async () => {
    const first = deferred<typeof initialSnapshot.global>();
    const second = deferred<typeof initialSnapshot.global>();
    api.updateGlobalSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const mounted = await mountProvider();

    let firstOperation!: Promise<void>;
    let secondOperation!: Promise<void>;
    act(() => {
      firstOperation = mounted.value.updateGlobal({ terminal: { fontSize: 14 } });
      secondOperation = mounted.value.updateGlobal({ terminal: { fontSize: 17 } });
    });
    await act(async () => Promise.resolve());
    expect(api.updateGlobalSettings).toHaveBeenCalledTimes(1);
    expect(mounted.value.global.terminal.fontSize).toBe(17);

    first.resolve({ ...initialSnapshot.global, terminal: { ...initialSnapshot.global.terminal, fontSize: 14 } });
    await act(async () => firstOperation);
    expect(api.updateGlobalSettings).toHaveBeenCalledTimes(2);
    expect(mounted.value.global.terminal.fontSize).toBe(17);

    second.resolve({ ...initialSnapshot.global, terminal: { ...initialSnapshot.global.terminal, fontSize: 17 } });
    await act(async () => secondOperation);
    expect(mounted.value.global.terminal.fontSize).toBe(17);
    expect(mounted.value.confirmedGlobal.terminal.fontSize).toBe(17);
    await unmount(mounted.root, mounted.host);
  });
});
