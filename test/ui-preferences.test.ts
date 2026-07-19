// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyUiPreferences,
  defaultUiPreferences,
  parseUiPreferences,
} from "../src/web/client/src/features/settings/ui-preferences";

interface MediaHarness {
  media: MediaQueryList;
  emit(matches: boolean): void;
  listenerCount(): number;
}

function mediaHarness(initialMatches: boolean): MediaHarness {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  return {
    media,
    emit(next) {
      matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-reduced-motion");
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("theme application", () => {
  test("canonical system choice wins over a stale resolved legacy theme", async () => {
    const harness = mediaHarness(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(harness.media);
    window.localStorage.setItem("nomoreide-theme-choice", "dark");
    window.localStorage.setItem(
      "nomoreide:ui-preferences",
      JSON.stringify({ ...defaultUiPreferences(), theme: "system" }),
    );

    const theme = await import("../src/web/client/src/lib/theme");

    expect(theme.getTheme()).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  test("system follows color-scheme changes and explicit themes unsubscribe", async () => {
    const harness = mediaHarness(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(harness.media);
    const theme = await import("../src/web/client/src/lib/theme");

    theme.setTheme("system");
    expect(theme.getTheme()).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(harness.listenerCount()).toBe(1);

    harness.emit(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    theme.setTheme("light");
    expect(harness.listenerCount()).toBe(0);
    harness.emit(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  test("the header toggle cycles explicit light and dark choices", async () => {
    const harness = mediaHarness(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(harness.media);
    const theme = await import("../src/web/client/src/lib/theme");
    const { ThemeToggle } = await import(
      "../src/web/client/src/components/theme-toggle"
    );
    theme.setTheme("light");
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ThemeToggle)));

    await act(async () => host.querySelector("button")?.click());
    expect(theme.getTheme()).toBe("dark");
    await act(async () => host.querySelector("button")?.click());
    expect(theme.getTheme()).toBe("light");
    await act(async () => root.unmount());
  });
});

describe("appearance preferences", () => {
  test("applies bounded code sizing, compact density, and reduced motion", () => {
    const preferences = {
      ...defaultUiPreferences(),
      codeFontSize: 18,
      density: "compact" as const,
      reducedMotion: true,
    };
    applyUiPreferences(preferences);

    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.reducedMotion).toBe("true");
    expect(document.documentElement.style.getPropertyValue("--code-font-size")).toBe("18px");
    expect(parseUiPreferences({ ...preferences, codeFontSize: 9 })).toBeNull();
    expect(parseUiPreferences({ ...preferences, codeFontSize: 19 })).toBeNull();
  });

  test("appearance CSS is scoped to settings rows, motion, and opted-in code surfaces", () => {
    const styles = readFileSync(
      resolve(__dirname, "../src/web/client/src/styles.css"),
      "utf8",
    );
    const settingControls = readFileSync(
      resolve(__dirname, "../src/web/client/src/features/settings/setting-controls.tsx"),
      "utf8",
    );
    const consumers = [
      "../src/web/client/src/features/services/log-viewer.tsx",
      "../src/web/client/src/features/git/diff-viewer.tsx",
      "../src/web/client/src/features/database/sql-console.tsx",
      "../src/web/client/src/features/database/table-grid.tsx",
    ].map((path) => readFileSync(resolve(__dirname, path), "utf8"));

    expect(styles).toContain("--code-font-size: 12px");
    expect(styles).toContain("--settings-row-padding:");
    expect(styles).toContain('[data-density="compact"]');
    expect(styles).toContain('[data-reduced-motion="true"] *');
    expect(styles).toContain(".code-font-size");
    expect(settingControls).toContain("settings-row");
    for (const source of consumers) expect(source).toContain("code-font-size");
  });
});
