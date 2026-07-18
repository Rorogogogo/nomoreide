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
      version: 1,
      theme: "light",
      language: "zh",
      density: "comfortable",
      codeFontSize: 12,
      sidebarDocked: true,
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
      version: 1,
      theme: "system",
      language: "zh",
      sidebarDocked: false,
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
        projectScope: "workspace",
      }),
    );

    expect(loadUiPreferences()).toMatchObject({
      theme: "system",
      language: "en",
      density: "comfortable",
      codeFontSize: 12,
      sidebarDocked: false,
      projectScope: "all",
    });
  });
});

describe("SettingsProvider", () => {
  test("loads the API snapshot once under React StrictMode", async () => {
    const mounted = await mountProvider(true);

    expect(api.getSettings).toHaveBeenCalledOnce();
    expect(mounted.value.loading).toBe(false);
    await unmount(mounted.root, mounted.host);
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
    await act(async () => {
      mounted.value.updateUi({ density: "compact", sidebarDocked: true });
    });

    await act(async () => mounted.value.resetProject());
    expect(api.resetProjectSettings).toHaveBeenCalledOnce();
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

  test("stays saving until concurrent global and project saves have both settled", async () => {
    const globalSave = deferred<typeof initialSnapshot.global>();
    const projectSave = deferred<typeof initialSnapshot.project>();
    api.updateGlobalSettings.mockReturnValue(globalSave.promise);
    api.updateProjectSettings.mockReturnValue(projectSave.promise);
    const mounted = await mountProvider();

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
