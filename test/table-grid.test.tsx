// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppContextMenu } from "../src/web/client/src/components/app-context-menu";
import { AiContextMenuProvider } from "../src/web/client/src/features/agent/context-menu/ai-context-menu";
import { TableGrid } from "../src/web/client/src/features/database/table-grid";
import type { RowSample } from "../src/web/client/src/lib/api";

const mocks = vi.hoisted(() => ({
  deleteRows: vi.fn(),
  setUnlocked: vi.fn(),
  showError: vi.fn(),
  showSuccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ deleteDatabaseRows: mocks.deleteRows }));

vi.mock("@/components/ui/toast", () => ({
  useToasts: () => ({ error: mocks.showError, success: mocks.showSuccess }),
}));

vi.mock("../src/web/client/src/features/database/use-databases", () => ({
  useWriteAccess: () => ({ updating: false, setUnlocked: mocks.setUnlocked }),
}));

const SAMPLE: RowSample = {
  engine: "sqlite",
  table: { name: "users", qualifiedName: "users" },
  columns: [
    { name: "id", dataType: "INTEGER", nullable: false, primaryKey: true },
    { name: "email", dataType: "TEXT", nullable: false, primaryKey: false },
  ],
  rows: [
    { id: 1, email: "a@example.com" },
    { id: 2, email: "b@example.com" },
    { id: 3, email: "c@example.com" },
  ],
  rowCount: 3,
  limit: 100,
  offset: 0,
};

let host: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  mocks.deleteRows.mockReset();
  mocks.setUnlocked.mockReset().mockResolvedValue(undefined);
  mocks.showError.mockReset();
  mocks.showSuccess.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.querySelectorAll('[role="menu"]').forEach((menu) => menu.remove());
});

function rows() {
  return Array.from(host.querySelectorAll<HTMLTableRowElement>("tbody tr"));
}

function button(label: string, scope: ParentNode = document) {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function renderGrid(props: Partial<React.ComponentProps<typeof TableGrid>> = {}) {
  await act(async () => {
    root.render(
      <TableGrid
        connection="app"
        objectKey="opaque-users"
        sample={SAMPLE}
        {...props}
      />,
    );
  });
}

describe("TableGrid row actions", () => {
  test("cycles a column through ascending, descending, and default order", async () => {
    const onSortChange = vi.fn();
    await renderGrid({ onSortChange });
    expect(button("email", host)?.querySelector(".lucide-arrow-up-down")).toBeTruthy();
    await act(async () => button("email", host)?.click());
    expect(onSortChange).toHaveBeenLastCalledWith({ column: "email", direction: "asc" });

    await renderGrid({
      onSortChange,
      sort: { column: "email", direction: "asc" },
    });
    await act(async () => button("email", host)?.click());
    expect(onSortChange).toHaveBeenLastCalledWith({ column: "email", direction: "desc" });

    await renderGrid({
      onSortChange,
      sort: { column: "email", direction: "desc" },
    });
    expect(button("email", host)?.querySelector(".lucide-arrow-down")).toBeTruthy();
    await act(async () => button("email", host)?.click());
    expect(onSortChange).toHaveBeenLastCalledWith(undefined);
  });

  test("selects multiple rows and copies them as one CSV document", async () => {
    await renderGrid();

    await act(async () => rows()[0]?.click());
    await act(async () => {
      rows()[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });

    expect(host.textContent).toContain("2 selected");
    await act(async () => button("Copy as CSV", host)?.click());
    expect(writeText).toHaveBeenCalledWith(
      "id,email\n1,a@example.com\n3,c@example.com",
    );
  });

  test("puts copy and guarded delete actions in the shared row context menu", async () => {
    await act(async () => {
      root.render(
        <AiContextMenuProvider>
          <AppContextMenu onRefresh={vi.fn()}>
            <main>
              <TableGrid
                connection="app"
                objectKey="opaque-users"
                sample={SAMPLE}
                writeUnlocked
              />
            </main>
          </AppContextMenu>
        </AiContextMenuProvider>,
      );
    });

    await act(async () => {
      rows()[1]?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: 40,
        clientY: 60,
      }));
    });

    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual([
      "AI",
      "Copy as JSON",
      "Copy as CSV",
      "Copy as SQL INSERT",
      "Delete selected rows",
      "Refresh⌘R",
    ]);
    await act(async () => items[1]?.click());
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(SAMPLE.rows[1], null, 2));
  });

  test("previews and confirms deletion before committing the same primary keys", async () => {
    const onDeleted = vi.fn();
    mocks.deleteRows
      .mockResolvedValueOnce({
        engine: "sqlite",
        previewUnavailable: false,
        affectedRows: 2,
        committed: false,
      })
      .mockResolvedValueOnce({
        engine: "sqlite",
        previewUnavailable: false,
        affectedRows: 2,
        committed: true,
      });
    await renderGrid({ onDeleted, writeUnlocked: true });
    await act(async () => rows()[0]?.click());
    await act(async () => {
      rows()[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    });

    await act(async () => button("Delete", host)?.click());
    expect(mocks.deleteRows).toHaveBeenNthCalledWith(1, "app", {
      objectKey: "opaque-users",
      keys: [{ id: 1 }, { id: 2 }],
      mode: "preview",
    });
    expect(document.body.textContent).toContain("preview matched 2 row(s)");

    await act(async () => button("Delete rows")?.click());
    expect(mocks.deleteRows).toHaveBeenNthCalledWith(2, "app", {
      objectKey: "opaque-users",
      keys: [{ id: 1 }, { id: 2 }],
      mode: "commit",
      expectedAffectedRows: 2,
    });
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("selected");
  });

  test("does not expose deletion when the sampled object has no primary key", async () => {
    await renderGrid({
      sample: {
        ...SAMPLE,
        columns: SAMPLE.columns.map((column) => ({ ...column, primaryKey: false })),
      },
    });
    await act(async () => rows()[0]?.click());
    expect(button("Delete", host)).toBeUndefined();
  });
});
