// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContextView } from "../src/web/client/src/features/context/context-view";

const api = vi.hoisted(() => ({
  createContextNote: vi.fn(),
  deleteContextNote: vi.fn(),
  getContextGraph: vi.fn(),
  getContextNote: vi.fn(),
  listContext: vi.fn(),
  setContextPins: vi.fn(),
  updateContextNote: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ attachContextItem: vi.fn() }),
}));
vi.mock("@/features/git/code-editor", () => ({
  CodeEditor: ({ ariaLabel, onChange, value }: {
    ariaLabel?: string;
    onChange: (value: string) => void;
    value: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    />
  ),
}));

const note = {
  ref: { kind: "note" as const, id: "note-1" },
  title: "Architecture",
  kind: "note" as const,
  excerpt: "Original body",
  path: "Notes/architecture.md",
  tags: [],
  aliases: [],
  pinned: false,
  editable: true,
  body: "Original body",
  revision: "a".repeat(64),
  links: [],
  projectPaths: [],
  frontmatter: {},
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.listContext.mockResolvedValue({
    vaultPath: "/tmp/context",
    items: [{ ...note }],
    pinned: [],
    diagnostics: [],
    truncated: false,
  });
  api.getContextGraph.mockResolvedValue({ nodes: [], edges: [], truncated: false });
  api.getContextNote.mockResolvedValue({ ...note });
  api.setContextPins.mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("ContextView", () => {
  test("keeps unsaved editor content when search refreshes the list", async () => {
    await act(async () => {
      root.render(<ContextView />);
    });
    await act(async () => Promise.resolve());

    const editor = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Context note Markdown"]',
    );
    expect(editor?.value).toBe("Original body");
    if (!editor) throw new Error("context editor did not render");
    await act(async () => {
      editor.value = "Unsaved body";
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search context"]');
    if (!search) throw new Error("context search did not render");
    await act(async () => {
      search.value = "arch";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await act(async () => Promise.resolve());

    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Context note Markdown"]')?.value)
      .toBe("Unsaved body");
  });
});
