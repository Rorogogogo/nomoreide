// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperationProvider } from "../apps/dashboard/src/components/operations/operation-context";
import { ProfileContents } from "../apps/dashboard/src/features/agent-env/profile-contents";

const api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getAgentEnvProfile: api.getProfile,
  updateAgentEnvProfile: api.updateProfile,
}));

const profile = {
  name: "dev-kit",
  description: "Original description",
  sourceAgent: "claude" as const,
  mcps: {
    github: { kind: "local" as const, command: "npx", args: ["github-mcp"] },
  },
  skills: [{ name: "commit-push" }],
  plugins: [],
};

let root: Root;
let host: HTMLDivElement;

async function renderEditor() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <OperationProvider>
        <ProfileContents name="dev-kit" onChanged={vi.fn()} />
      </OperationProvider>,
    );
  });
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  if (!match) throw new Error(`button not found: ${name}`);
  return match;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.getProfile.mockResolvedValue(profile);
  api.updateProfile.mockImplementation(async (_name, patch) => ({ ...profile, ...patch }));
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ProfileContents", () => {
  test("keeps description edits as a draft until Save is selected", async () => {
    await renderEditor();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Profile description"]')!;

    await typeInto(input, "Updated description");

    expect(button("Save")).toBeTruthy();
    expect(api.updateProfile).not.toHaveBeenCalled();

    await act(async () => button("Save").click());

    expect(api.updateProfile).toHaveBeenCalledWith("dev-kit", {
      description: "Updated description",
    });
  });

  test("requires confirmation before removing a bundled item", async () => {
    await renderEditor();

    await act(async () => button("Remove github from profile").click());

    expect(document.body.textContent).toContain("Remove profile item?");
    expect(api.updateProfile).not.toHaveBeenCalled();

    await act(async () => button("Remove").click());

    expect(api.updateProfile).toHaveBeenCalledWith("dev-kit", { mcps: {} });
  });
});
