import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWebServer } from "../src/web/server.js";

let tempDir: string;
let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-context-routes-"));
  server = await createWebServer({
    configPath: join(tempDir, "config.json"),
    contextRoot: join(tempDir, "vault"),
    logDir: join(tempDir, "logs"),
    registryPath: join(tempDir, "runtime.json"),
    cwd: tempDir,
    port: 0,
  }).start();
});

afterEach(async () => {
  await server.stop();
  await rm(tempDir, { recursive: true, force: true });
});

describe("context routes", () => {
  test("creates, lists, updates, previews, pins, and deletes notes", async () => {
    let response = await fetch(`${server.url}/api/context/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Runbook", body: "Restart only after checking logs." }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()).note;

    response = await fetch(`${server.url}/api/context`);
    expect((await response.json()).items).toContainEqual(expect.objectContaining({ title: "Runbook", kind: "note" }));

    response = await fetch(`${server.url}/api/context/pins`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refs: [created.ref] }),
    });
    expect((await response.json()).pinned).toEqual([created.ref]);

    response = await fetch(`${server.url}/api/context/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachment: { refs: [], includePinned: true } }),
    });
    expect((await response.json()).preview.context).toContain("checking logs");

    response = await fetch(`${server.url}/api/context/notes/${created.ref.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: created.revision }),
    });
    expect(response.status).toBe(200);
  });

  test("returns a conflict for stale revisions", async () => {
    const created = await fetch(`${server.url}/api/context/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Runbook" }),
    }).then((response) => response.json()).then((body) => body.note);

    const response = await fetch(`${server.url}/api/context/notes/${created.ref.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Runbook", body: "changed", projectPaths: [], tags: [], aliases: [], revision: "0".repeat(64) }),
    });
    expect(response.status).toBe(409);
  });
});
