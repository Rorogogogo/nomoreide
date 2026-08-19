import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { JetBrainsImportSessions } from "../src/core/jetbrains-import.js";

const fixtureRoot = resolve("test/fixtures/jetbrains-project");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("JetBrains run configuration import", () => {
  test("adapts supported shared configs and keeps env values out of preview", async () => {
    const sessions = new JetBrainsImportSessions();

    const preview = await sessions.scan({
      projectRoot: fixtureRoot,
      includePersonal: false,
      existingNames: ["npm-dev"],
    });

    expect(preview.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "npm-dev",
          command: "npm",
          args: ["run", "dev"],
          envKeys: ["API_TOKEN", "NODE_ENV"],
          conflict: true,
        }),
        expect.objectContaining({
          name: "api-node",
          command: "node",
          args: [
            join(fixtureRoot, "apps/api/server.js"),
            "--port",
            "3001",
            "--label",
            "API server",
          ],
        }),
      ]),
    );
    expect(preview.candidates.map((candidate) => candidate.name)).not.toContain("personal-cargo");
    expect(preview.unsupported).toContainEqual(
      expect.objectContaining({ name: "mobile", reason: expect.stringMatching(/not supported/i) }),
    );
    expect(JSON.stringify(preview)).not.toContain("fixture-secret");
    expect(preview.databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "project-postgres",
          engine: "postgres",
          host: "localhost",
          port: 5432,
          database: "project",
          username: "app",
        }),
        expect.objectContaining({
          name: "local-sqlite",
          engine: "sqlite",
          path: join(fixtureRoot, "data/app.sqlite"),
        }),
      ]),
    );
    expect(preview.unsupportedDatabases).toContainEqual(
      expect.objectContaining({ name: "legacy-oracle", reason: expect.stringMatching(/only/i) }),
    );
    expect(JSON.stringify(preview)).not.toContain("embedded-secret");
    expect(JSON.stringify(preview)).not.toContain("query-secret");
    expect(JSON.stringify(preview)).not.toContain("token-secret");
  });

  test("includes personal workspace configs only when explicitly enabled", async () => {
    const preview = await new JetBrainsImportSessions().scan({
      projectRoot: fixtureRoot,
      includePersonal: true,
      existingNames: [],
    });

    expect(preview.candidates).toContainEqual(
      expect.objectContaining({
        name: "personal-cargo",
        command: "cargo",
        args: ["run", "--bin", "local-tool"],
      }),
    );
  });

  test("applies selected services atomically with explicit rename and replace behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomoreide-jetbrains-"));
    temporary.push(dir);
    const store = new ConfigStore(join(dir, "config.json"));
    await store.registerService({ name: "npm-dev", command: "old", cwd: fixtureRoot });
    const sessions = new JetBrainsImportSessions();
    const preview = await sessions.scan({
      projectRoot: fixtureRoot,
      includePersonal: false,
      existingNames: ["npm-dev"],
    });
    const npm = preview.candidates.find((candidate) => candidate.name === "npm-dev");
    const node = preview.candidates.find((candidate) => candidate.name === "api-node");
    expect(npm).toBeDefined();
    expect(node).toBeDefined();
    if (!npm || !node) throw new Error("Expected fixture candidates.");

    const imported = await sessions.consume(preview.sessionId, [
      { id: npm.id, conflict: "replace" },
      { id: node.id, conflict: "rename", name: "api-imported" },
    ]);
    await store.importServices(imported.services);

    const services = (await store.load()).services;
    expect(services.find((service) => service.name === "npm-dev")).toMatchObject({
      command: "npm",
      args: ["run", "dev"],
      env: { API_TOKEN: "fixture-secret", NODE_ENV: "development" },
    });
    expect(services.find((service) => service.name === "api-imported")).toMatchObject({
      command: "node",
    });

    const before = await readFile(join(dir, "config.json"), "utf8");
    await expect(
      store.importServices([
        {
          definition: { name: "npm-dev", command: "collision", cwd: fixtureRoot },
          onConflict: "error",
        },
      ]),
    ).rejects.toThrow(/already registered/i);
    expect(await readFile(join(dir, "config.json"), "utf8")).toBe(before);
  });

  test("injects prompted database credentials and always imports write-locked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomoreide-jetbrains-db-"));
    temporary.push(dir);
    const store = new ConfigStore(join(dir, "config.json"));
    const sessions = new JetBrainsImportSessions();
    const preview = await sessions.scan({
      projectRoot: fixtureRoot,
      includePersonal: false,
      existingNames: [],
      existingDatabaseNames: [],
    });
    const postgres = preview.databases.find((candidate) => candidate.name === "project-postgres");
    const sqlite = preview.databases.find((candidate) => candidate.name === "local-sqlite");
    if (!postgres || !sqlite) throw new Error("Expected database fixtures.");

    const imported = await sessions.consume(preview.sessionId, [], [
      {
        id: postgres.id,
        conflict: "add",
        username: "runtime_user",
        password: "prompted-secret",
      },
      { id: sqlite.id, conflict: "add" },
    ]);
    await store.importProjectSetup(imported);

    const databases = (await store.load()).databases;
    const remote = databases.find((database) => database.name === "project-postgres");
    expect(remote?.url).toContain("runtime_user:prompted-secret@");
    expect(remote?.url).not.toContain("embedded-secret");
    expect(remote?.url).not.toContain("query-secret");
    expect(remote?.url).not.toContain("token-secret");
    expect(databases.every((database) => database.writeUnlocked === false)).toBe(true);
  });

  test("rejects DTD-bearing XML without parsing configurations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomoreide-jetbrains-dtd-"));
    temporary.push(dir);
    const runDir = join(dir, ".run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "unsafe.run.xml"),
      '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><configuration name="bad" type="ShConfigurationType"><option name="SCRIPT_TEXT" value="&secret;" /></configuration>',
    );

    const preview = await new JetBrainsImportSessions().scan({
      projectRoot: dir,
      includePersonal: false,
      existingNames: [],
    });

    expect(preview.candidates).toEqual([]);
    expect(preview.unsupported[0]?.reason).toMatch(/DTD and entity/i);
  });

  test.runIf(process.platform !== "win32")(
    "rejects a known-path symlink that escapes the project",
    async () => {
      const project = await mkdtemp(join(tmpdir(), "nomoreide-jetbrains-project-"));
      const outside = await mkdtemp(join(tmpdir(), "nomoreide-jetbrains-outside-"));
      temporary.push(project, outside);
      await mkdir(join(project, ".run"), { recursive: true });
      const target = join(outside, "escaped.run.xml");
      await writeFile(target, '<configuration name="bad" type="ShConfigurationType"></configuration>');
      await symlink(target, join(project, ".run", "escaped.run.xml"));

      await expect(
        new JetBrainsImportSessions().scan({
          projectRoot: project,
          includePersonal: false,
          existingNames: [],
        }),
      ).rejects.toThrow(/escapes the project root/i);
    },
  );

  test.runIf(process.platform !== "win32")(
    "rejects an edited working directory that escapes through a symlink",
    async () => {
      const project = await mkdtemp(join(tmpdir(), "nomoreide-jetbrains-project-"));
      const outside = await mkdtemp(join(tmpdir(), "nomoreide-jetbrains-outside-"));
      temporary.push(project, outside);
      await mkdir(join(project, ".run"), { recursive: true });
      await writeFile(
        join(project, ".run", "safe.run.xml"),
        '<configuration name="safe" type="ShConfigurationType"><option name="SCRIPT_TEXT" value="echo safe" /></configuration>',
      );
      await symlink(outside, join(project, "linked-outside"));
      const sessions = new JetBrainsImportSessions();
      const preview = await sessions.scan({
        projectRoot: project,
        includePersonal: false,
        existingNames: [],
      });

      await expect(
        sessions.consume(preview.sessionId, [
          {
            id: preview.candidates[0]?.id ?? "missing",
            conflict: "add",
            cwd: join(project, "linked-outside"),
          },
        ]),
      ).rejects.toThrow(/escapes the project/i);
    },
  );
});
