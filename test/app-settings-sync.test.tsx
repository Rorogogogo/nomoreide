// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsProjectSync } from "../apps/dashboard/src/app";

afterEach(() => {
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

test("syncs each selected repository path into the settings provider", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selectProject = vi.fn(async () => undefined);

  await act(async () => {
    root.render(<SettingsProjectSync projectPath="/work/a" selectProject={selectProject} />);
  });
  await act(async () => {
    root.render(<SettingsProjectSync projectPath="/work/b" selectProject={selectProject} />);
  });
  await act(async () => root.unmount());

  expect(selectProject).toHaveBeenNthCalledWith(1, "/work/a");
  expect(selectProject).toHaveBeenNthCalledWith(2, "/work/b");
});
