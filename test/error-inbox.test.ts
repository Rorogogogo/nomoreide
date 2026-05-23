import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { ErrorInbox, type ErrorIncident } from "../src/core/error-inbox.js";
import { LogStore } from "../src/core/log-store.js";

let tempDir: string;
let logs: LogStore;
let configStore: ConfigStore;
let inbox: ErrorInbox;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-errors-"));
  logs = new LogStore({ baseDir: tempDir, maxLinesPerService: 100 });
  configStore = new ConfigStore(join(tempDir, "config.json"));
  inbox = new ErrorInbox({ logStore: logs, configStore, cwd: tempDir });
});

afterEach(async () => {
  inbox.dispose();
  await rm(tempDir, { recursive: true, force: true });
});

describe("ErrorInbox", () => {
  test("creates an incident from an error log line", async () => {
    await logs.append("api", "stderr", "Error: connection refused");

    const incidents = inbox.list();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      service: "api",
      level: "error",
      count: 1,
      title: "Error: connection refused",
    });
  });

  test("ignores plain info lines", async () => {
    await logs.append("api", "stdout", "Server listening on port 3000");
    await logs.append("api", "stdout", "Compiled with 0 errors");

    expect(inbox.list()).toHaveLength(0);
  });

  test("dedupes repeated errors by normalized signature", async () => {
    await logs.append("api", "stderr", "Error: request 1234 failed");
    await logs.append("api", "stderr", "Error: request 5678 failed");

    const incidents = inbox.list();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].count).toBe(2);
  });

  test("treats different services as distinct incidents", async () => {
    await logs.append("api", "stderr", "Error: boom");
    await logs.append("web", "stderr", "Error: boom");

    expect(inbox.list()).toHaveLength(2);
  });

  test("extracts the top frame from a Node stack trace", async () => {
    await logs.append("api", "stderr", "TypeError: cannot read x");
    await logs.append("api", "stderr", "    at handler (/srv/api/src/routes.ts:42:7)");
    await logs.append("api", "stderr", "    at next (/srv/api/node_modules/express/index.js:1:1)");

    const incident = inbox.list()[0];
    expect(incident.file).toBe("/srv/api/src/routes.ts");
    expect(incident.line).toBe(42);
    expect(incident.logExcerpt.join("\n")).toContain("at handler");
  });

  test("extracts the top frame from a Python traceback", async () => {
    await logs.append("worker", "stderr", "Traceback (most recent call last):");
    await logs.append("worker", "stderr", '  File "/app/worker.py", line 17, in run');
    await logs.append("worker", "stderr", "ValueError: bad input");

    const incident = inbox.list()[0];
    expect(incident.file).toBe("/app/worker.py");
    expect(incident.line).toBe(17);
  });

  test("notifies subscribers when an incident is touched", async () => {
    const seen: ErrorIncident[] = [];
    inbox.subscribe((incident) => seen.push(incident));

    await logs.append("api", "stderr", "Error: kaboom");

    expect(seen).toHaveLength(1);
    expect(seen[0].title).toBe("Error: kaboom");
  });

  test("assembles a copy-to-agent prompt with the log excerpt", async () => {
    await logs.append("api", "stdout", "handling request");
    await logs.append("api", "stderr", "Error: database unavailable");

    const incident = inbox.list()[0];
    const payload = await inbox.buildPrompt(incident.id);

    expect(payload).not.toBeNull();
    expect(payload?.prompt).toContain("**api** service");
    expect(payload?.prompt).toContain("Error: database unavailable");
    expect(payload?.prompt).toContain("Last");
  });

  test("returns null for an unknown incident id", async () => {
    expect(await inbox.buildPrompt(999)).toBeNull();
  });
});
