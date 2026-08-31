// @vitest-environment happy-dom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperationProvider } from "../apps/dashboard/src/components/operations/operation-context";
import { SqlConsole } from "../apps/dashboard/src/features/database/sql-console";
import { useTableBrowser } from "../apps/dashboard/src/features/database/use-databases";
import {
  LogViewer,
  logEntryText,
} from "../apps/dashboard/src/features/services/log-viewer";
import type { LogEntry } from "../apps/dashboard/src/lib/api";

const api = vi.hoisted(() => ({
  executeWrite: vi.fn(),
  getRows: vi.fn(),
  getTables: vi.fn(),
  listDatabases: vi.fn(),
  runQuery: vi.fn(),
  setWriteAccess: vi.fn(),
}));

const sqlGenerate = vi.hoisted(() => ({
  cancel: vi.fn(),
  generate: vi.fn(),
  generating: false,
}));

vi.mock("../apps/dashboard/src/lib/api", () => ({
  executeDatabaseWrite: api.executeWrite,
  getDatabaseRows: api.getRows,
  getDatabaseTables: api.getTables,
  listDatabases: api.listDatabases,
  runDatabaseQuery: api.runQuery,
  setDatabaseWriteAccess: api.setWriteAccess,
}));

vi.mock("../apps/dashboard/src/components/ui/toast", () => ({
  useToasts: () => ({ error: vi.fn(), success: vi.fn() }),
}));

vi.mock("../apps/dashboard/src/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ sendToAgent: vi.fn() }),
}));

vi.mock("../apps/dashboard/src/features/database/use-sql-generate", () => ({
  useSqlGenerate: () => ({ ...sqlGenerate, error: null }),
}));

async function mount(node: ReactNode): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<OperationProvider>{node}</OperationProvider>));
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
  window.localStorage.clear();
  api.executeWrite.mockReset().mockResolvedValue({ affectedRows: 1, committed: true });
  api.runQuery.mockReset().mockResolvedValue({ columns: [], rows: [], truncated: false });
  api.getRows.mockReset();
  api.getTables.mockReset();
  api.listDatabases.mockReset();
  api.setWriteAccess.mockReset();
  sqlGenerate.cancel.mockReset();
  sqlGenerate.generate.mockReset();
  sqlGenerate.generating = false;
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
  test("renders query tabs and saved-query controls inside the SQL workspace", async () => {
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        unlocked={false}
      />,
    );

    expect(mounted.host.querySelector('[role="tablist"]')?.textContent).toContain("Untitled 1");
    expect(mounted.host.textContent).toContain("Saved queries");
    expect(mounted.host.textContent).not.toContain("Connectionprimary");
    await act(async () => mounted.root.unmount());
  });

  test("shows the agent wave loader and Stop action while SQL is generating", async () => {
    sqlGenerate.generating = true;
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        unlocked={false}
      />,
    );

    expect(mounted.host.querySelector('[role="status"]')?.textContent).toContain("Generating");
    const stop = [...mounted.host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Stop",
    );
    await act(async () => stop?.click());
    expect(sqlGenerate.cancel).toHaveBeenCalledOnce();
    await act(async () => mounted.root.unmount());
  });

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
    await act(async () => mounted.root.render(
      <OperationProvider>
        <Harness resultLimit={500} />
      </OperationProvider>,
    ));
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
      button.textContent?.includes("Dry run"),
    );
    await act(async () => run?.click());

    expect(api.executeWrite).toHaveBeenCalledWith("primary", "DELETE FROM jobs", "preview");
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Execute change");
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
      button.textContent?.includes("Execute change"),
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
      button.textContent?.includes("Execute change"),
    )!;
    await act(async () => run.click());

    expect(run.disabled).toBe(true);
    await act(async () => resolveCommit({ affectedRows: 1, committed: true }));
    await act(async () => mounted.root.unmount());
  });

  test("restores an automatic SQL draft after the console remounts", async () => {
    const first = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        unlocked={false}
      />,
    );
    await enterSql(first.host, "SELECT * FROM users;");
    await act(async () => first.root.unmount());

    const second = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        unlocked={false}
      />,
    );
    expect(second.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "SELECT * FROM users;",
    );
    await act(async () => second.root.unmount());
  });

  test("accepts generated statements from the SQL object explorer without replacing the draft", async () => {
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        editorAction={{
          connection: "primary",
          mode: "statement",
          nonce: 1,
          sql: "SELECT * FROM public.users LIMIT 100;",
        }}
        onWriteAccessChange={vi.fn()}
        unlocked={false}
      />,
    );
    expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "SELECT * FROM public.users LIMIT 100;",
    );
    await enterSql(mounted.host, "SELECT 1;");
    await act(async () => mounted.root.render(
      <OperationProvider>
        <SqlConsole
          connection="primary"
          editorAction={{
            connection: "primary",
            mode: "statement",
            nonce: 2,
            sql: "SELECT * FROM public.jobs LIMIT 100;",
          }}
          onWriteAccessChange={vi.fn()}
          unlocked={false}
        />
      </OperationProvider>,
    ));
    expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "SELECT 1;\n\nSELECT * FROM public.jobs LIMIT 100;",
    );
    await act(async () => mounted.root.unmount());
  });

  test("saves the current draft as a named query", async () => {
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        unlocked={false}
      />,
    );
    await enterSql(mounted.host, "SELECT id FROM users;");
    const save = [...mounted.host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Save",
    );
    await act(async () => save?.click());

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const name = dialog?.querySelector<HTMLInputElement>("input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(name, "User IDs");
      name?.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (candidate) => candidate.textContent?.includes("Save query"),
    );
    await act(async () => confirm?.click());

    const stored = JSON.parse(
      window.localStorage.getItem("nomoreide:database:saved-queries:v1") ?? "[]",
    ) as Array<{ connection: string; name: string; sql: string }>;
    expect(stored).toMatchObject([
      { connection: "primary", name: "User IDs", sql: "SELECT id FROM users;" },
    ]);
    await act(async () => mounted.root.unmount());
  });

  test("keeps independent drafts when switching open query tabs", async () => {
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        unlocked={false}
      />,
    );
    await enterSql(mounted.host, "SELECT 1;");
    const add = [...mounted.host.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "New query",
    );
    await act(async () => add?.click());
    expect(mounted.host.querySelectorAll('[role="tab"]').length).toBe(2);
    expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");

    await enterSql(mounted.host, "SELECT 2;");
    const first = [...mounted.host.querySelectorAll("button")].find(
      (candidate) => candidate.title === "Untitled 1",
    );
    await act(async () => first?.click());
    expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("SELECT 1;");
    await act(async () => mounted.root.unmount());
  });

  test("offers save and discard choices before closing a dirty query tab", async () => {
    const mounted = await mount(
      <SqlConsole
        connection="primary"
        onWriteAccessChange={vi.fn()}
        unlocked={false}
      />,
    );
    await enterSql(mounted.host, "SELECT 1;");
    const close = [...mounted.host.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "Close Untitled 1",
    );
    await act(async () => close?.click());

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("Discard changes");
    expect(dialog?.textContent).toContain("Save");
    expect(dialog?.textContent).toContain("Cancel");
    await act(async () => mounted.root.unmount());
  });
});
