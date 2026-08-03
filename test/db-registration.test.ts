import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { DbPeek } from "../src/core/db-peek.js";

describe("database registration", () => {
  let tempDir: string;
  let dbPeek: DbPeek;
  let store: ConfigStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nomoreide-db-register-"));
    store = new ConfigStore(join(tempDir, "config.json"));
    dbPeek = new DbPeek({ configStore: store });
  });

  afterEach(async () => {
    await dbPeek.closeAll();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("registers offline without returning credentials or unlocking writes", async () => {
    const result = await dbPeek.register({
      name: "app",
      engine: "postgres",
      url: "postgres://user:secret@localhost/app",
      projectPath: "/workspace/app",
      check: false,
    });
    expect(result).toEqual({
      name: "app",
      engine: "postgres",
      url: "postgres://user:****@localhost/app",
      projectPath: "/workspace/app",
      writeUnlocked: false,
    });
    expect((await store.load()).databases[0]?.url).toContain("secret");
  });

  test("requires explicit replacement and re-locks the replacement", async () => {
    await dbPeek.register({ name: "app", engine: "sqlite", url: "/tmp/a.db", check: false });
    await store.setDatabaseWriteAccess("app", true);
    await expect(
      dbPeek.register({ name: "app", engine: "sqlite", url: "/tmp/b.db", check: false }),
    ).rejects.toThrow(/replace=true/);
    const replaced = await dbPeek.register({
      name: "app",
      engine: "sqlite",
      url: "/tmp/b.db",
      check: false,
      replace: true,
    });
    expect(replaced.writeUnlocked).toBe(false);
  });
});
