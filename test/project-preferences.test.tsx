// @vitest-environment happy-dom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SqlConsole } from "../src/web/client/src/features/database/sql-console";
import { useTableBrowser } from "../src/web/client/src/features/database/use-databases";
import {
  LogViewer,
  logEntryText,
} from "../src/web/client/src/features/services/log-viewer";
import type { LogEntry } from "../src/web/client/src/lib/api";

const api = vi.hoisted(() => ({
  executeWrite: vi.fn(),
  getRows: vi.fn(),
  getTables: vi.fn(),
  listDatabases: vi.fn(),
  runQuery: vi.fn(),
  setWriteAccess: vi.fn(),
}));

vi.mock("../src/web/client/src/lib/api", () => ({
  executeDatabaseWrite: api.executeWrite,
  getDatabaseRows: api.getRows,
  getDatabaseTables: api.getTables,
  listDatabases: api.listDatabases,
  runDatabaseQuery: api.runQuery,
  setDatabaseWriteAccess: api.setWriteAccess,
}));

vi.mock("../src/web/client/src/components/ui/toast", () => ({
  useToasts: () => ({ error: vi.fn(), success: vi.fn() }),
}));

vi.mock("../src/web/client/src/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ sendToAgent: vi.fn() }),
}));

vi.mock("../src/web/client/src/features/database/use-sql-generate", () => ({
  useSqlGenerate: () => ({ error: null, generate: vi.fn(), generating: false }),
}));

async function mount(node: ReactNode): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, root };
}

async function enterSql(host: HTMLElement, sql: string) {
  const textarea = host.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, sql);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.executeWrite.mockReset().mockResolvedValue({ affectedRows: 1, committed: true });
  api.runQuery.mockReset().mockResolvedValue({ columns: [], rows: [], truncated: false });
  api.getRows.mockReset();
  api.getTables.mockReset();
  api.listDatabases.mockReset();
  api.setWriteAccess.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

describe("project log preferences", () => {
  const entry: LogEntry = {
    service: "web",
    stream: "stdout",
    text: "server ready",
    timestamp: "2026-07-19T01:02:03.456Z",
  };

  test("hides the timestamp gutter without removing timestamps from search text", () => {
    const markup = renderToStaticMarkup(
      <LogViewer
        containerRef={createRef<HTMLDivElement>()}
        emptyText="No logs"
        logs={[entry]}
        query=""
        showTimestamps={false}
        wrapLines
      />,
    );

    expect(markup).not.toContain("01:02:03.456");
    expect(markup).not.toContain("grid-cols-[88px_");
    expect(logEntryText(entry)).toContain(entry.timestamp);
  });

  test("uses preformatted single lines and horizontal overflow when wrapping is off", () => {
    const markup = renderToStaticMarkup(
      <LogViewer
        containerRef={createRef<HTMLDivElement>()}
        emptyText="No logs"
        logs={[entry]}
        query=""
        showTimestamps
        wrapLines={false}
      />,
    );

    expect(markup).toContain("overflow-auto");
    expect(markup).toContain("whitespace-pre");
    expect(markup).not.toContain("whitespace-pre-wrap");
  });
});

describe("project database preferences", () => {
  test("uses the project result limit initially without replacing an explicit lower choice", async () => {
    let browser!: ReturnType<typeof useTableBrowser>;
    function Harness({ resultLimit }: { resultLimit: number }) {
      browser = useTableBrowser(null, resultLimit);
      return null;
    }
    const mounted = await mount(<Harness resultLimit={200} />);
    expect(browser.limit).toBe(200);

    act(() => browser.changePageSize(50));
    expect(browser.limit).toBe(50);
    await act(async () => mounted.root.render(<Harness resultLimit={500} />));
    expect(browser.limit).toBe(50);
    await act(async () => mounted.root.unmount());
  });

  test("passes the project cap while preserving an explicitly lower SQL LIMIT", async () => {
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        engine="postgres"
        onWriteAccessChange={vi.fn()}
        preferences={{ confirmWrites: true, resultLimit: 200 }}
        unlocked
      />,
    );
    await enterSql(mounted.host, "SELECT * FROM users LIMIT 10");
    const run = [...mounted.host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Run",
    );
    await act(async () => run?.click());

    expect(api.runQuery).toHaveBeenCalledWith(
      "primary",
      "SELECT * FROM users LIMIT 10",
      200,
    );
    await act(async () => mounted.root.unmount());
  });

  test("previews unlocked writes when confirmation is enabled", async () => {
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        preferences={{ confirmWrites: true, resultLimit: 100 }}
        unlocked
      />,
    );
    await enterSql(mounted.host, "DELETE FROM jobs");
    const run = [...mounted.host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Preview write"),
    );
    await act(async () => run?.click());

    expect(api.executeWrite).toHaveBeenCalledWith("primary", "DELETE FROM jobs", "preview");
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Run & commit");
    await act(async () => mounted.root.unmount());
  });

  test("commits unlocked writes directly only when confirmation is disabled", async () => {
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        preferences={{ confirmWrites: false, resultLimit: 100 }}
        unlocked
      />,
    );
    await enterSql(mounted.host, "DELETE FROM jobs");
    const run = [...mounted.host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Run write"),
    );
    await act(async () => run?.click());

    expect(api.executeWrite).toHaveBeenCalledWith("primary", "DELETE FROM jobs", "commit");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => mounted.root.unmount());
  });

  test("disables direct write submission while its commit is pending", async () => {
    let resolveCommit!: (value: { affectedRows: number; committed: boolean }) => void;
    api.executeWrite.mockReturnValue(
      new Promise((resolve) => {
        resolveCommit = resolve;
      }),
    );
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        preferences={{ confirmWrites: false, resultLimit: 100 }}
        unlocked
      />,
    );
    await enterSql(mounted.host, "DELETE FROM jobs");
    const run = [...mounted.host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Run write"),
    )!;
    await act(async () => run.click());

    expect(run.disabled).toBe(true);
    await act(async () => resolveCommit({ affectedRows: 1, committed: true }));
    await act(async () => mounted.root.unmount());
  });
});
