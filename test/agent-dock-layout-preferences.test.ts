// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  AGENT_DOCK_LAYOUT_KEY,
  defaultAgentDockLayoutPreferences,
  loadAgentDockLayoutPreferences,
  parseAgentDockLayoutPreferences,
  saveAgentDockLayoutPreferences,
} from "../apps/dashboard/src/features/agent/terminal/agent-dock-layout-preferences";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("agent dock layout preferences", () => {
  test("round-trips the persisted workbench layout", () => {
    const preferences = {
      ...defaultAgentDockLayoutPreferences(),
      open: true,
      bottomHeight: 420,
      rightWidth: 640,
      splitPercent: 68,
      rightTaskIds: ["right-1", "right-2"],
      activeLeftTaskId: "left-1",
      activeRightTaskId: "right-2",
      focusedPane: "right" as const,
    };

    expect(saveAgentDockLayoutPreferences(preferences)).toBe(true);
    expect(loadAgentDockLayoutPreferences()).toEqual(preferences);
  });

  test("sanitizes malformed geometry and pane assignments", () => {
    expect(
      parseAgentDockLayoutPreferences({
        version: 1,
        open: "yes",
        bottomHeight: -1,
        rightWidth: Number.POSITIVE_INFINITY,
        splitPercent: 90,
        rightTaskIds: ["right", "", "right", 42],
        activeLeftTaskId: "",
        activeRightTaskId: 42,
        focusedPane: "middle",
      }),
    ).toEqual({
      ...defaultAgentDockLayoutPreferences(),
      splitPercent: 75,
      rightTaskIds: ["right"],
    });
  });

  test("falls back safely when storage is invalid or unavailable", () => {
    window.localStorage.setItem(AGENT_DOCK_LAYOUT_KEY, "{not-json");
    expect(loadAgentDockLayoutPreferences()).toEqual(
      defaultAgentDockLayoutPreferences(),
    );

    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(loadAgentDockLayoutPreferences()).toEqual(
      defaultAgentDockLayoutPreferences(),
    );
  });
});
