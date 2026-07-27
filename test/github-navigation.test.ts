// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  requestGitHubActions,
  subscribeToGitHubActions,
} from "../src/web/client/src/features/github/github-navigation.js";

describe("GitHub Actions navigation intent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("persists the Actions tab and selected branch for a later mount", () => {
    requestGitHubActions("feature/dock-status");

    expect(window.localStorage.getItem("nomoreide:github:tab")).toBe('"actions"');
    expect(window.localStorage.getItem("nomoreide:github:actions-branch")).toBe(
      '"feature/dock-status"',
    );
  });

  test("notifies an already-mounted GitHub view", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToGitHubActions(listener);

    requestGitHubActions("main");

    expect(listener).toHaveBeenCalledWith({ branch: "main" });
    unsubscribe();
    requestGitHubActions("release");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
