// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../apps/dashboard/src/components/ui/context-menu.js";
import { AppContextMenu } from "../apps/dashboard/src/components/app-context-menu.js";
import { GistPopover } from "../apps/dashboard/src/components/gist-popover.js";
import {
  AiContextMenuProvider,
  AiContextTarget,
} from "../apps/dashboard/src/features/agent/context-menu/ai-context-menu.js";

const { sendToAgentMock } = vi.hoisted(() => ({ sendToAgentMock: vi.fn() }));

vi.mock(
  "../apps/dashboard/src/features/agent/chat/agent-context.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../apps/dashboard/src/features/agent/chat/agent-context.js")
    >()),
    useAgentDock: () => ({ sendToAgent: sendToAgentMock }),
  }),
);

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  host?.remove();
  root = undefined;
  host = undefined;
  window.localStorage.clear();
  sendToAgentMock.mockReset();
});

async function renderMenu(onSelect: () => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ContextMenu>
        <ContextMenuTrigger data-testid="trigger">Right-click me</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onSelect}>Open</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
  });
  return host.querySelector<HTMLElement>('[data-testid="trigger"]');
}

describe("ContextMenu", () => {
  test("shows every project gist with its project badge in all-project mode", async () => {
    window.localStorage.setItem(
      "nomoreide:gist:current:/projects/alpha",
      JSON.stringify({
        pieces: [{ id: "alpha-note", type: "text", value: "Alpha note" }],
      }),
    );
    window.localStorage.setItem(
      "nomoreide:gist:current:/projects/beta",
      JSON.stringify({
        pieces: [{ id: "beta-note", type: "text", value: "Beta note" }],
      }),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <GistPopover
              aggregateProjects
              projects={[
                { name: "Alpha", path: "/projects/alpha" },
                { name: "Beta", path: "/projects/beta" },
              ]}
            />
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });
    await act(async () => {
      host
        ?.querySelector<HTMLButtonElement>('[aria-label="Open project gist"]')
        ?.click();
    });

    const alphaNote = document.body.querySelector<HTMLElement>(
      '[data-gist-piece-id="alpha-note"]',
    );
    const betaNote = document.body.querySelector<HTMLElement>(
      '[data-gist-piece-id="beta-note"]',
    );
    expect(alphaNote?.textContent).toContain("Alpha");
    expect(alphaNote?.textContent).toContain("Alpha note");
    expect(betaNote?.textContent).toContain("Beta");
    expect(betaNote?.textContent).toContain("Beta note");

    await act(async () =>
      alphaNote?.querySelector<HTMLButtonElement>(
        '[data-gist-piece-delete="alpha-note"]',
      )?.click(),
    );
    expect(document.body.querySelector('[data-gist-piece-id="alpha-note"]')).toBeNull();
    expect(JSON.parse(
      window.localStorage.getItem("nomoreide:gist:current:/projects/alpha") ?? "null",
    )).toEqual({ pieces: [] });
    expect(document.body.querySelector('[data-gist-piece-id="beta-note"]')).toBeTruthy();
  });

  test("uses the global AI context menu for Gist notes", async () => {
    window.localStorage.setItem(
      "nomoreide:gist:current:test",
      JSON.stringify({
        pieces: [{ id: "note-1", type: "text", value: "Remember this" }],
      }),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <div>
              <GistPopover scopeKey="test" />
            </div>
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });
    await act(async () => {
      host
        ?.querySelector<HTMLButtonElement>('[aria-label="Open project gist"]')
        ?.click();
    });

    const note = document.body.querySelector<HTMLElement>(
      '[data-gist-piece-id="note-1"]',
    );
    const sendButton = note?.querySelector<HTMLButtonElement>(
      '[data-gist-piece-send="note-1"]',
    );
    const deleteButton = note?.querySelector<HTMLButtonElement>(
      '[data-gist-piece-delete="note-1"]',
    );
    expect(sendButton).toBeTruthy();
    expect(deleteButton).toBeTruthy();
    await act(async () => sendButton?.click());
    expect(sendToAgentMock).toHaveBeenCalledWith({
      label: "Gist note",
      mode: "send",
      prompt: "Remember this",
      source: { type: "gist", label: "Gist note" },
    });

    const badge = document.body.querySelector<HTMLElement>("[data-ai-cursor-badge]");
    await act(async () => {
      note?.dispatchEvent(new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 40,
        clientY: 60,
      }));
    });
    expect(badge?.style.opacity).toBe("1");

    await act(async () => {
      note?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          cancelable: true,
          clientX: 40,
          clientY: 60,
        }),
      );
    });

    const appMenu = document.body.querySelector<HTMLElement>("[data-app-context-menu]");
    expect(appMenu?.classList.contains("z-[1100]")).toBe(true);
    expect(document.body.querySelector("[data-gist-menu]")).toBeNull();
    expect(
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(["AI", "Remove", "Refresh⌘R"]);

    const panel = document.body.querySelector<HTMLElement>("[data-gist-panel]");
    await act(async () => {
      panel?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      panel?.click();
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(panel?.classList.contains("translate-x-0")).toBe(true);

    await act(async () => deleteButton?.click());
    expect(document.body.querySelector('[data-gist-piece-id="note-1"]')).toBeNull();
    expect(panel?.classList.contains("translate-x-0")).toBe(true);

    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(panel?.classList.contains("translate-x-full")).toBe(true);
  });

  test("opens at the pointer on right click and invokes an item", async () => {
    const onSelect = vi.fn();
    const trigger = await renderMenu(onSelect);

    await act(async () => {
      trigger?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 40,
          clientY: 60,
        }),
      );
    });

    const item = document.body.querySelector<HTMLElement>('[role="menuitem"]');
    expect(item?.textContent).toBe("Open");

    await act(async () => item?.click());
    expect(onSelect).toHaveBeenCalledOnce();
  });

  test("replaces the native app menu with the custom actions", async () => {
    const onRefresh = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={onRefresh}>
            <main data-testid="app-shell">Workspace</main>
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });

    const shell = host.querySelector<HTMLElement>('[data-testid="app-shell"]');
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      button: 2,
      cancelable: true,
      clientX: 40,
      clientY: 60,
    });
    await act(async () => shell?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual(["Refresh⌘R"]);

    await act(async () => items.at(-1)?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  test("shows clipboard actions only for an editable text target", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <input data-testid="editor" defaultValue="draft text" />
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });

    const input = host.querySelector<HTMLInputElement>('[data-testid="editor"]');
    input?.setSelectionRange(0, 5);
    await act(async () => {
      input?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          cancelable: true,
          clientX: 40,
          clientY: 60,
        }),
      );
    });

    const items = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    expect(items.map((item) => item.textContent)).toEqual([
      "Cut⌘X",
      "Copy⌘C",
      "Paste⌘V",
      "Select all⌘A",
      "Refresh⌘R",
    ]);
  });

  test("adds Send and Copy delivery under AI for the nearest registered target", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <div>
            <AiContextTarget
              target={{
                label: "users row",
                intents: [{
                  id: "explain",
                  label: "Explain row",
                  resolvePrompt: () => "Explain users row 42",
                  source: { type: "database-row", label: "users row" },
                }],
              }}
            >
              <main data-testid="ai-target">Row 42</main>
            </AiContextTarget>
            </div>
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });

    const target = host.querySelector<HTMLElement>('[data-testid="ai-target"]');
    await act(async () => {
      target?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          cancelable: true,
          clientX: 40,
          clientY: 60,
        }),
      );
    });

    const aiItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === "AI");
    expect(aiItem).toBeTruthy();

    await act(async () => {
      aiItem?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
      aiItem?.click();
    });

    const deliveryItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    const copyItem = deliveryItems.find((item) => item.textContent === "Copy prompt");
    expect(copyItem).toBeTruthy();

    await act(async () => copyItem?.click());
    expect(writeText).toHaveBeenCalledWith("Explain users row 42");
  });

  test("shows a tiny round AI badge beside the cursor over AI targets", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <div data-testid="shell">
              <AiContextTarget
                target={{
                  label: "service row",
                  intents: [{
                    id: "debug",
                    label: "Debug service",
                    resolvePrompt: () => "Debug service",
                    source: { type: "service", label: "service row" },
                  }],
                }}
              >
                <div data-testid="ai-hover-target">API service</div>
              </AiContextTarget>
            </div>
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });

    const badge = document.body.querySelector<HTMLElement>("[data-ai-cursor-badge]");
    const target = host.querySelector<HTMLElement>('[data-testid="ai-hover-target"]');
    await act(async () => {
      target?.dispatchEvent(new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 40,
        clientY: 60,
      }));
    });
    expect(badge?.textContent).toBe("AI");
    expect(badge?.style.opacity).toBe("1");
    expect(badge?.style.transform).toBe("translate3d(50px, 72px, 0) scale(1)");

    const shell = host.querySelector<HTMLElement>('[data-testid="shell"]');
    await act(async () => {
      shell?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    expect(badge?.style.opacity).toBe("0");
  });

});
