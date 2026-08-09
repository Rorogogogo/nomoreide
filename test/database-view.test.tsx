// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DatabaseView } from "../src/web/client/src/features/database/database-view";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("../src/web/client/src/features/database/use-databases", () => ({
  useDatabases: () => ({
    connections: [
      { name: "primary", engine: "postgres", url: "postgres://masked", writeUnlocked: false },
    ],
    error: null,
    loading: false,
    refresh,
  }),
}));

vi.mock("../src/web/client/src/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ sendToAgent: vi.fn() }),
}));

vi.mock("../src/web/client/src/features/database/database-explorer", () => ({
  DatabaseExplorer: ({ sidebarOnly }: { sidebarOnly?: boolean }) => (
    <div data-testid={sidebarOnly ? "sql-explorer" : "browse-explorer"} />
  ),
}));

vi.mock("../src/web/client/src/features/database/sql-console", () => ({
  SqlConsole: () => <div data-testid="sql-console" />,
}));

vi.mock("@/lib/api", () => ({
  deleteDatabase: vi.fn(),
}));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  refresh.mockReset();
});

describe("DatabaseView workspace visibility", () => {
  test("does not let the inactive SQL grid cover the Browse workspace", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<DatabaseView />));
    await act(async () => Promise.resolve());

    const sqlWorkspace = host.querySelector<HTMLElement>('[data-database-workspace="sql"]');
    const browseWorkspace = host.querySelector<HTMLElement>('[data-database-workspace="browse"]');
    expect(sqlWorkspace?.classList.contains("hidden")).toBe(true);
    expect(sqlWorkspace?.classList.contains("grid")).toBe(false);
    expect(browseWorkspace?.classList.contains("hidden")).toBe(false);
    expect(host.querySelector('[data-testid="browse-explorer"]')).toBeTruthy();
    expect(host.querySelector("header")?.textContent).toContain("primary");
    expect(host.querySelector("header")?.textContent).toContain("postgres");

    const sqlTab = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "SQL",
    );
    await act(async () => sqlTab?.click());

    expect(sqlWorkspace?.classList.contains("grid")).toBe(true);
    expect(sqlWorkspace?.classList.contains("hidden")).toBe(false);
    expect(browseWorkspace?.classList.contains("hidden")).toBe(true);
    expect(host.querySelector('[data-testid="sql-console"]')).toBeTruthy();

    await act(async () => root.unmount());
    host.remove();
  });
});
