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
import {
  headerActionClassName,
} from "../src/web/client/src/components/header-action";

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
  test("header actions keep a fixed footprint through focus and theme changes", () => {
    // They used to widen to reveal a label, which made a mouse click resize the
    // control. Fixed size-7 buttons cannot shift the header at all; the label
    // moved to a tooltip.
    const className = headerActionClassName();
    expect(className).toContain("size-7");
    expect(className).not.toContain("w-24");
    expect(className).toContain("focus-visible:ring-2");
  });

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

  test("the header toggle reveals from the first pointer position", async () => {
    const harness = mediaHarness(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(harness.media);
    const animate = vi.fn();
    Object.defineProperty(document.documentElement, "animate", {
      configurable: true,
      value: animate,
    });
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { ready: Promise.resolve(), finished: new Promise<void>(() => {}) };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
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
    const button = host.querySelector("button");
    const icon = button?.querySelector("span");
    vi.spyOn(icon!, "getBoundingClientRect").mockReturnValue({
      bottom: 40,
      height: 28,
      left: 940,
      right: 968,
      top: 12,
      width: 28,
      x: 940,
      y: 12,
      toJSON: () => ({}),
    });

    await act(async () => {
      button?.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        clientX: 1111,
        clientY: 23,
        detail: 1,
      }));
      await Promise.resolve();
    });

    expect(startViewTransition).toHaveBeenCalledOnce();
    // Percentages, not pixels: on the first view transition of a page Chrome
    // sizes ::view-transition-new(root) in device pixels, which halves an
    // absolute centre on a 2x display. See the comment in theme-toggle.tsx.
    const originX = `${(1111 / window.innerWidth) * 100}%`;
    const originY = `${(23 / window.innerHeight) * 100}%`;
    const endRadius = Math.hypot(1111, window.innerHeight - 23) + 2;
    const reference =
      Math.hypot(window.innerWidth, window.innerHeight) / Math.SQRT2;
    expect(animate).toHaveBeenCalledWith(
      expect.objectContaining({
        clipPath: [
          `circle(0% at ${originX} ${originY})`,
          `circle(${(endRadius / reference) * 100}% at ${originX} ${originY})`,
        ],
      }),
      expect.objectContaining({
        fill: "forwards",
        pseudoElement: "::view-transition-new(root)",
      }),
    );
    await act(async () => root.unmount());
    Reflect.deleteProperty(document, "startViewTransition");
    Reflect.deleteProperty(document.documentElement, "animate");
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
