import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../src/cli/commands.js";

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = undefined;
}

let tempDir: string;
let configPath: string;
let output: string[];
let errors: string[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-db-cli-"));
  configPath = join(tempDir, "config.json");
  output = [];
  errors = [];
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("database CLI", () => {
  test("registers and lists a masked database connection", async () => {
    expect(await runCli([
      "db",
      "add",
      "app",
      "--engine",
      "postgres",
      "--url",
      "postgres://user:secret@localhost/app",
      "--no-check",
    ], options())).toBe(0);

    output = [];
    expect(await runCli(["db", "list"], options())).toBe(0);
    expect(output.join("\n")).toContain("postgres://user:****@localhost/app");
    expect(output.join("\n")).not.toContain("secret");
  });

  test.skipIf(!DatabaseSync)("lists objects and prints an SQLite create script", async () => {
    const databasePath = join(tempDir, "app.db");
    const database = new DatabaseSync!(databasePath);
    database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL)");
    database.close();
    expect(await runCli([
      "db",
      "add",
      "app",
      "--engine",
      "sqlite",
      "--url",
      databasePath,
    ], options())).toBe(0);

    output = [];
    expect(await runCli(["db", "objects", "app", "--schema", "main"], options())).toBe(0);
    const objects = JSON.parse(output.join("\n")) as Array<{ key: string; name: string }>;
    const users = objects.find((object) => object.name === "users");
    expect(users).toBeDefined();

    output = [];
    expect(await runCli(["db", "script", "app", "--key", users?.key ?? ""], options())).toBe(0);
    expect(output.join("\n")).toContain("CREATE TABLE users");
  });
});

function options() {
  return {
    configPath,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
  };
}
