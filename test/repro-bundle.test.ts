import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { ErrorInbox } from "../src/core/error-inbox.js";
import { LogStore } from "../src/core/log-store.js";
import { ProcessManager } from "../src/core/process-manager.js";
import { ReproBundleBuilder } from "../src/core/repro-bundle.js";

let tempDir: string;
let logs: LogStore;
let configStore: ConfigStore;
let inbox: ErrorInbox;
let manager: ProcessManager;
let builder: ReproBundleBuilder;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-repro-"));
  logs = new LogStore({ baseDir: join(tempDir, "logs"), maxLinesPerService: 100 });
  configStore = new ConfigStore(join(tempDir, "config.json"));
  inbox = new ErrorInbox({ logStore: logs, configStore, cwd: tempDir });
  manager = new ProcessManager({ configStore, logStore: logs });
  builder = new ReproBundleBuilder({
    errorInbox: inbox,
    manager,
    reproDir: join(tempDir, "repros"),
  });
});

afterEach(async () => {
  inbox.dispose();
  await rm(tempDir, { recursive: true, force: true });
});

describe("ReproBundleBuilder", () => {
  test("returns null for an unknown incident", async () => {
    expect(await builder.build(999)).toBeNull();
  });

  test("renders incident, service state, and masked env into markdown", async () => {
    await configStore.registerService({ name: "api", command: "sleep 1", cwd: tempDir });
    await writeFile(join(tempDir, ".env"), "API_URL=http://localhost:3000\nAPI_SECRET=hunter2\n");
    await logs.append("api", "stderr", "Error: connection refused");

    const incident = inbox.list()[0];
    const bundle = await builder.build(incident.id);

    expect(bundle).not.toBeNull();
    const md = bundle?.markdown ?? "";
    expect(md).toContain("# Bug report: Error: connection refused");
    expect(md).toContain("## Error");
    expect(md).toContain("## Service state");
    expect(md).toContain("## Environment");
    // Non-secret values are kept; secret-looking keys are masked.
    expect(md).toContain("http://localhost:3000");
    expect(md).not.toContain("hunter2");
    expect(md).toContain("••••••");
  });

  test("notes a missing .env file", async () => {
    await configStore.registerService({ name: "api", command: "sleep 1", cwd: tempDir });
    await logs.append("api", "stderr", "Error: boom");

    const bundle = await builder.build(inbox.list()[0].id);
    expect(bundle?.markdown).toContain("No `.env` file found");
  });

  test("writes the bundle to disk when save is set", async () => {
    await configStore.registerService({ name: "api", command: "sleep 1", cwd: tempDir });
    await logs.append("api", "stderr", "Error: boom");

    const bundle = await builder.build(inbox.list()[0].id, { save: true });
    expect(bundle?.savedPath).toBeDefined();
    const written = await readFile(bundle?.savedPath ?? "", "utf8");
    expect(written).toBe(bundle?.markdown);
  });
});
