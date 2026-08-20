import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  details: vi.fn(),
  exportObject: vi.fn(),
  cancelExport: vi.fn(),
  deleteRows: vi.fn(),
  execute: vi.fn(),
  listDatabases: vi.fn(),
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  query: vi.fn(),
  sample: vi.fn(),
  test: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));

vi.mock("../apps/dashboard/src/lib/api/tauri-bridge", () => ({
  tauri_databaseCapabilities: mocks.capabilities,
  tauri_deleteDatabaseRows: mocks.deleteRows,
  tauri_executeDatabase: mocks.execute,
  tauri_exportDatabaseObject: mocks.exportObject,
  tauri_cancelDatabaseExport: mocks.cancelExport,
  tauri_getDatabaseObjectDetails: mocks.details,
  tauri_listDatabaseObjects: mocks.listObjects,
  tauri_listDatabaseSchemas: mocks.listSchemas,
  tauri_listDatabases: mocks.listDatabases,
  tauri_listTables: mocks.listTables,
  tauri_queryDatabase: mocks.query,
  tauri_registerDatabase: vi.fn(),
  tauri_removeDatabase: vi.fn(),
  tauri_sampleDatabaseObject: mocks.sample,
  tauri_setDatabaseWriteAccess: vi.fn(),
  tauri_testDatabaseConnection: mocks.test,
}));

import { tauriDatabaseApi } from "../apps/dashboard/src/lib/api/database-tauri";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDatabases.mockResolvedValue([
    { name: "prod", engine: "postgres", url: "postgres://masked", writeUnlocked: false },
  ]);
});

describe("Tauri database adapter", () => {
  test("saves an all-row export directly through the native writer", async () => {
    mocks.save.mockResolvedValue("/tmp/users.csv");
    mocks.exportObject.mockResolvedValue({
      rowsWritten: 5001,
      bytesWritten: 120000,
      maskedColumns: ["api_token"],
    });

    await expect(
      tauriDatabaseApi.exportDatabaseObject("app", "opaque", "csv", "app-users.csv"),
    ).resolves.toMatchObject({
      delivery: "file",
      path: "/tmp/users.csv",
      rowsWritten: 5001,
    });
    expect(mocks.save).toHaveBeenCalledWith({
      defaultPath: "app-users.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    expect(mocks.exportObject).toHaveBeenCalledWith(expect.objectContaining({
      name: "app",
      key: "opaque",
      format: "csv",
      path: "/tmp/users.csv",
    }));
  });

  test("tests the unsaved connection instead of a fake registered name", async () => {
    await expect(
      tauriDatabaseApi.testDatabase({ engine: "postgres", url: "postgres://user:secret@host/app" }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.test).toHaveBeenCalledWith("postgres", "postgres://user:secret@host/app");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  test("uses catalog commands and preserves the registered result engine", async () => {
    mocks.listSchemas.mockResolvedValue([{ name: "public" }]);
    mocks.listObjects.mockResolvedValue([{ key: "opaque", schema: "public", name: "users", kind: "table", qualifiedName: "public.users" }]);
    mocks.query.mockResolvedValue({ columns: ["id"], rows: [[1]], rowCount: 1 });

    expect(await tauriDatabaseApi.getDatabaseSchemas("prod")).toEqual([{ name: "public" }]);
    expect(await tauriDatabaseApi.getDatabaseObjects("prod", "public")).toHaveLength(1);
    expect(await tauriDatabaseApi.runDatabaseQuery("prod", "SELECT 1", 10)).toMatchObject({
      engine: "postgres",
      rows: [{ id: 1 }],
    });
  });

  test("passes preview and commit modes through to the transactional Rust command", async () => {
    mocks.execute.mockResolvedValue({ engine: "sqlite", previewUnavailable: false, affectedRows: 2, committed: false });
    await expect(tauriDatabaseApi.executeDatabaseWrite("app", "DELETE FROM users", "preview")).resolves.toMatchObject({ committed: false });
    expect(mocks.execute).toHaveBeenCalledWith("app", "DELETE FROM users", "preview");
  });

  test("passes structured row keys through to the guarded Rust delete command", async () => {
    const input = {
      objectKey: "opaque-users",
      keys: [{ id: 1 }, { id: 2 }],
      mode: "preview" as const,
    };
    mocks.deleteRows.mockResolvedValue({
      engine: "sqlite",
      previewUnavailable: false,
      affectedRows: 2,
      committed: false,
    });
    await expect(tauriDatabaseApi.deleteDatabaseRows("app", input)).resolves.toMatchObject({
      affectedRows: 2,
    });
    expect(mocks.deleteRows).toHaveBeenCalledWith("app", input);
  });

  test("passes browser filters and sorting to the native catalog command", async () => {
    mocks.sample.mockResolvedValue({ rows: [], columns: [], rowCount: 0 });
    const query = {
      filters: [{ column: "name", operator: "startsWith" as const, value: "sam" }],
      sort: { column: "created_at", direction: "desc" as const },
    };

    await tauriDatabaseApi.getDatabaseObjectRows("app", "opaque", 50, 100, query);

    expect(mocks.sample).toHaveBeenCalledWith("app", "opaque", 50, 100, query);
  });
});
