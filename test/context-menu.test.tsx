// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../src/web/client/src/components/ui/context-menu.js";
import { AppContextMenu } from "../src/web/client/src/components/app-context-menu.js";
import {
  AiContextMenuProvider,
  AiContextTarget,
} from "../src/web/client/src/features/agent/context-menu/ai-context-menu.js";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  host?.remove();
  root = undefined;
  host = undefined;
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
    expect(items.map((item) => item.textContent)).toEqual([
      "Cut⌘X",
      "Copy⌘C",
      "Paste⌘V",
      "Select all⌘A",
      "Refresh⌘R",
    ]);

    await act(async () => items.at(-1)?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
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
    const copyItem = deliveryItems.find((item) =>
      item.textContent?.includes("Copy “Explain row” prompt"),
    );
    expect(copyItem).toBeTruthy();

    await act(async () => copyItem?.click());
    expect(writeText).toHaveBeenCalledWith("Explain users row 42");
  });
});
