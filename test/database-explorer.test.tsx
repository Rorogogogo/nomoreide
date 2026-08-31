// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppContextMenu } from "../apps/dashboard/src/components/app-context-menu";
import { AiContextMenuProvider } from "../apps/dashboard/src/features/agent/context-menu/ai-context-menu";
import { DatabaseExplorer } from "../apps/dashboard/src/features/database/database-explorer";
import type { DatabaseConnection } from "../apps/dashboard/src/lib/api";

const mocks = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  getDetails: vi.fn(),
  exportObject: vi.fn(),
  getObjects: vi.fn(),
  getRows: vi.fn(),
  getSchemas: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  exportDatabaseObject: mocks.exportObject,
  getDatabaseCapabilities: mocks.getCapabilities,
  getDatabaseObjectDetails: mocks.getDetails,
  getDatabaseObjectRows: mocks.getRows,
  getDatabaseObjects: mocks.getObjects,
  getDatabaseSchemas: mocks.getSchemas,
}));

vi.mock("../apps/dashboard/src/features/database/table-grid", () => ({
  TableGrid: ({ sample }: { sample: { rowCount: number } }) => (
    <div data-testid="rows">{sample.rowCount}</div>
  ),
}));

const CONNECTIONS: DatabaseConnection[] = [
  { name: "app", engine: "sqlite", url: "/tmp/app.db", writeUnlocked: false },
  { name: "analytics", engine: "postgres", url: "postgres://masked", writeUnlocked: false },
  { name: "billing", engine: "mysql", url: "mysql://masked", writeUnlocked: false },
];

let container: HTMLDivElement;
let root: Root;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getCapabilities.mockResolvedValue({
    objectKinds: ["table", "view"],
    tableDetails: ["columns", "indexes", "constraints", "triggers"],
  });
  mocks.getSchemas.mockResolvedValue([{ name: "main" }]);
  mocks.getObjects.mockResolvedValue([
    { key: "opaque-users", schema: "main", name: "users", kind: "table", qualifiedName: "users" },
  ]);
  mocks.getDetails.mockResolvedValue({
    object: { key: "opaque-users", schema: "main", name: "users", kind: "table", qualifiedName: "users" },
    columns: [{ name: "id", dataType: "INTEGER", nullable: false, primaryKey: true }],
    indexes: [], constraints: [], triggers: [],
    definition: "CREATE TABLE users (id INTEGER)",
    createScript: "CREATE TABLE users (id INTEGER);",
  });
  mocks.getRows.mockResolvedValue({
    engine: "sqlite",
    object: { key: "opaque-users", schema: "main", name: "users", kind: "table", qualifiedName: "users" },
    table: { name: "users", qualifiedName: "users" },
    columns: [{ name: "id", dataType: "INTEGER", nullable: false, primaryKey: true }],
    rows: [{ id: 1 }], rowCount: 1, limit: 100, offset: 0,
  });
  mocks.exportObject.mockResolvedValue({ delivery: "browser", url: "/download.csv" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
}

describe("DatabaseExplorer", () => {
  test("exports every row from the Data tab as CSV or JSON", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    act(() => {
      root.render(
        <StrictMode>
          <DatabaseExplorer
          connections={CONNECTIONS}
          onAddConnection={vi.fn()}
          onAddWithAi={vi.fn()}
          onEditConnection={vi.fn()}
          onRemoveConnection={vi.fn()}
          onSelectConnection={vi.fn()}
          resultLimit={100}
          selectedConnection="app"
          />
        </StrictMode>,
      );
    });
    await flush();
    act(() => button("main")?.click());
    await flush();
    act(() => button("Tables")?.click());
    act(() => button("users")?.click());
    await flush();

    act(() => button("Export")?.click());
    expect(container.textContent).toContain("Sensitive columns stay masked");
    act(() => button("Export all as CSV")?.click());
    await flush();

    expect(mocks.exportObject).toHaveBeenCalledWith(
      "app",
      "opaque-users",
      "csv",
      expect.stringMatching(/^app-users-\d{4}-\d{2}-\d{2}\.csv$/),
      { signal: expect.any(AbortSignal) },
    );
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  test("renders the catalog tree without a detail pane for companion views", async () => {
    act(() => {
      root.render(
        <DatabaseExplorer
          connections={CONNECTIONS}
          onAddConnection={vi.fn()}
          onAddWithAi={vi.fn()}
          onEditConnection={vi.fn()}
          onRemoveConnection={vi.fn()}
          onSelectConnection={vi.fn()}
          resultLimit={100}
          selectedConnection="app"
          sidebarOnly
        />,
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="database-explorer-sidebar"]')).toBeTruthy();
    expect(button("app")?.getAttribute("aria-current")).toBe("true");
    expect(container.textContent).not.toContain("Select an object to inspect it.");

    act(() => button("main")?.click());
    await flush();
    expect(mocks.getObjects).toHaveBeenCalledWith("app", "main");
  });

  test("loads connection, schema, object, and detail branches lazily", async () => {
    act(() => {
      root.render(
        <DatabaseExplorer
          connections={CONNECTIONS}
          onAddConnection={vi.fn()}
          onAddWithAi={vi.fn()}
          onEditConnection={vi.fn()}
          onRemoveConnection={vi.fn()}
          onSelectConnection={vi.fn()}
          resultLimit={100}
          selectedConnection="app"
        />,
      );
    });
    await flush();

    expect(mocks.getSchemas).toHaveBeenCalledWith("app");
    expect(mocks.getSchemas).not.toHaveBeenCalledWith("analytics");
    expect(button("app")?.title).toBe("app (sqlite)");
    expect(button("analytics")?.title).toBe("analytics (postgres)");
    expect(button("billing")?.title).toBe("billing (mysql)");
    expect(button("app")?.querySelector("[data-database-engine]")?.getAttribute("class")).toContain("#0f80b5");
    expect(button("analytics")?.querySelector("[data-database-engine]")?.getAttribute("class")).toContain("#4169e1");
    expect(button("billing")?.querySelector("[data-database-engine]")?.getAttribute("class")).toContain("#e97b13");
    expect(button("main")).toBeTruthy();
    expect(mocks.getObjects).not.toHaveBeenCalled();

    act(() => button("main")?.click());
    await flush();
    expect(mocks.getObjects).toHaveBeenCalledWith("app", "main");

    act(() => button("Tables")?.click());
    expect(button("users")).toBeTruthy();
    act(() => button("users")?.click());
    await flush();

    expect(mocks.getDetails).toHaveBeenCalledWith("app", "opaque-users");
    expect(mocks.getRows).toHaveBeenCalledWith("app", "opaque-users", 100, 0, {
      filters: [],
      sort: undefined,
    });
    expect(container.querySelector('[data-testid="rows"]')?.textContent).toBe("1");
    expect(container.querySelector("#database-object-panel-structure")?.hasAttribute("hidden")).toBe(true);

    act(() => button("Filter")?.click());
    const filterValue = container.querySelector<HTMLInputElement>('[aria-label="Value"]');
    act(() => {
      if (filterValue) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          filterValue,
          "1",
        );
        filterValue.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    act(() => button("Add filter")?.click());
    await flush();
    expect(mocks.getRows).toHaveBeenLastCalledWith("app", "opaque-users", 100, 0, {
      filters: [{ column: "id", operator: "eq", value: "1" }],
      sort: undefined,
    });

    act(() => button("Structure")?.click());
    const structurePanel = container.querySelector("#database-object-panel-structure");
    expect(structurePanel?.textContent).toContain("INTEGER NOT NULL PRIMARY KEY");
    expect(structurePanel?.querySelector(".hljs-type")?.textContent).toBe("INTEGER");
    expect(container.querySelector("#database-object-panel-data")?.hasAttribute("hidden")).toBe(true);

    act(() => button("Create script")?.click());
    expect(container.textContent).toContain("CREATE TABLE users");
    expect(
      container.querySelector("#database-object-panel-script .hljs-keyword")?.textContent,
    ).toBe("CREATE TABLE");
  });

  test("keeps connection actions in the row context menu", async () => {
    const onEditConnection = vi.fn();
    const onRemoveConnection = vi.fn();
    act(() => {
      root.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <div>
              <DatabaseExplorer
                connections={CONNECTIONS}
                onAddConnection={vi.fn()}
                onAddWithAi={vi.fn()}
                onEditConnection={onEditConnection}
                onRemoveConnection={onRemoveConnection}
                onSelectConnection={vi.fn()}
                resultLimit={100}
                selectedConnection="app"
              />
            </div>
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });
    await flush();

    await act(async () => {
      button("analytics")?.dispatchEvent(
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
      "AI",
      "Edit",
      "Delete",
      "Refresh⌘R",
    ]);

    await act(async () => items[1]?.click());
    expect(onEditConnection).toHaveBeenCalledWith(CONNECTIONS[1]);
    expect(onRemoveConnection).not.toHaveBeenCalled();
  });

  test("keeps SQL object clicks in place and exposes browse, editor, and AI actions", async () => {
    const onSelectConnection = vi.fn();
    const onSelectionChange = vi.fn();
    const onOpenInBrowse = vi.fn();
    const onInsertName = vi.fn();
    const onGenerateSelect = vi.fn();
    act(() => {
      root.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <div>
              <DatabaseExplorer
                connections={CONNECTIONS}
                onAddConnection={vi.fn()}
                onAddWithAi={vi.fn()}
                onEditConnection={vi.fn()}
                onGenerateObjectSelect={onGenerateSelect}
                onInsertObjectName={onInsertName}
                onOpenObjectInBrowse={onOpenInBrowse}
                onRemoveConnection={vi.fn()}
                onSelectConnection={onSelectConnection}
                onSelectedCatalogObjectChange={onSelectionChange}
                resultLimit={100}
                selectedConnection="app"
                sidebarOnly
                surface="sql"
              />
            </div>
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });
    await flush();
    act(() => button("main")?.click());
    await flush();
    act(() => button("Tables")?.click());
    act(() => button("users")?.click());

    expect(onSelectionChange).toHaveBeenCalledWith({
      connection: "app",
      object: expect.objectContaining({ name: "users" }),
    });
    expect(onOpenInBrowse).not.toHaveBeenCalled();

    act(() => button("users")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onInsertName).toHaveBeenCalledWith({
      connection: "app",
      object: expect.objectContaining({ name: "users" }),
    });

    const openButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in Browse: users"]',
    );
    act(() => openButton?.click());
    expect(onOpenInBrowse).toHaveBeenCalledWith({
      connection: "app",
      object: expect.objectContaining({ name: "users" }),
    });
    onOpenInBrowse.mockClear();

    await act(async () => {
      button("users")?.dispatchEvent(
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
      "AI",
      "Open in Browse",
      "Insert qualified name",
      "Generate SELECT",
      "Refresh⌘R",
    ]);

    await act(async () => items[1]?.click());
    expect(onOpenInBrowse).toHaveBeenCalledWith({
      connection: "app",
      object: expect.objectContaining({ name: "users" }),
    });
  });

  test("copies structure names and definitions from the row context menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    act(() => {
      root.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <div>
              <DatabaseExplorer
                connections={CONNECTIONS}
                onAddConnection={vi.fn()}
                onAddWithAi={vi.fn()}
                onEditConnection={vi.fn()}
                onRemoveConnection={vi.fn()}
                onSelectConnection={vi.fn()}
                resultLimit={100}
                selectedConnection="app"
              />
            </div>
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });
    await flush();
    act(() => button("main")?.click());
    await flush();
    act(() => button("Tables")?.click());
    act(() => button("users")?.click());
    await flush();
    act(() => button("Structure")?.click());

    const row = container.querySelector<HTMLElement>('[title="id"]')?.parentElement;
    await act(async () => {
      row?.dispatchEvent(
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
      "Copy name",
      "Copy definition",
      "Refresh⌘R",
    ]);

    await act(async () => items[1]?.click());
    expect(writeText).toHaveBeenCalledWith("INTEGER NOT NULL PRIMARY KEY");
  });

  test("restores explorer expansion, selection, and detail tab after remount", async () => {
    const renderExplorer = () => (
      <DatabaseExplorer
        connections={CONNECTIONS}
        onAddConnection={vi.fn()}
        onAddWithAi={vi.fn()}
        onEditConnection={vi.fn()}
        onRemoveConnection={vi.fn()}
        onSelectConnection={vi.fn()}
        resultLimit={100}
        selectedConnection="app"
      />
    );
    act(() => root.render(renderExplorer()));
    await flush();
    act(() => button("main")?.click());
    await flush();
    act(() => button("Tables")?.click());
    act(() => button("users")?.click());
    await flush();
    act(() => button("Structure")?.click());

    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(renderExplorer()));
    await flush();
    await flush();

    expect(button("app")?.getAttribute("aria-expanded")).toBe("true");
    expect(button("main")?.getAttribute("aria-expanded")).toBe("true");
    expect(button("Tables")?.getAttribute("aria-expanded")).toBe("true");
    expect(button("users")).toBeTruthy();
    expect(button("Structure")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("#database-object-panel-structure")?.textContent).toContain(
      "INTEGER NOT NULL PRIMARY KEY",
    );
  });
});
