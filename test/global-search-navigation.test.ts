// @vitest-environment happy-dom

import { describe, expect, test, vi } from "vitest";
import {
  consumeGlobalSearchFocus,
  requestGlobalSearchFocus,
  subscribeToGlobalSearchFocus,
} from "../apps/dashboard/src/features/global-search/global-search-navigation";

describe("global search focus navigation", () => {
  test("a mounted non-matching view cannot consume another page's intent", () => {
    const gitListener = vi.fn();
    const unsubscribe = subscribeToGlobalSearchFocus("git-file", gitListener);

    requestGlobalSearchFocus({ type: "setting", category: "appearance", setting: "theme" });

    expect(gitListener).not.toHaveBeenCalled();
    expect(consumeGlobalSearchFocus("setting")).toEqual({
      type: "setting",
      category: "appearance",
      setting: "theme",
    });
    unsubscribe();
  });

  test("the matching mounted view claims the intent once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToGlobalSearchFocus("setting", listener);
    const intent = { type: "setting", category: "git-github", setting: "github-connection" } as const;

    requestGlobalSearchFocus(intent);

    expect(listener).toHaveBeenCalledWith(intent);
    expect(consumeGlobalSearchFocus("setting")).toBeNull();
    unsubscribe();
  });
});
