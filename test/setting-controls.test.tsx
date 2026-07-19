// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import {
  ManagementRow,
  SettingNumberInput,
} from "../src/web/client/src/features/settings/setting-controls";

afterEach(() => {
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

test("announces invalid numeric input and clears stale validation on confirmed rollback", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSave = vi.fn();
  const render = (value: number) => (
    <SettingNumberInput
      description="Maximum rows returned."
      id="row-limit"
      label="Row limit"
      max={5_000}
      min={10}
      onSave={onSave}
      value={value}
    />
  );
  await act(async () => root.render(render(100)));
  const input = host.querySelector<HTMLInputElement>("#row-limit")!;

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "0");
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Save Row limit"]')!.click());

  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Enter a value");

  await act(async () => root.render(render(250)));
  expect(input.value).toBe("250");
  expect(input.getAttribute("aria-invalid")).toBe("false");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => root.unmount());
});

test("stacks management actions on narrow layouts and protects both columns", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ManagementRow
      action={<button type="button">Open Agent Environments</button>}
      description="Manage installed agents, MCP servers, skills, and profiles."
      title="Agent environments"
    />,
  ));

  const row = host.firstElementChild as HTMLElement;
  expect(row.className).toContain("flex-col");
  expect(row.className).toContain("sm:flex-row");
  expect((row.firstElementChild as HTMLElement).className).toContain("min-w-0");
  expect((row.lastElementChild as HTMLElement).className).toContain("shrink-0");
  expect((row.lastElementChild as HTMLElement).className).toContain("w-full");
  expect((row.lastElementChild as HTMLElement).className).toContain("sm:w-auto");
  await act(async () => root.unmount());
});
