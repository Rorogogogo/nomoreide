import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TimelineStore } from "../src/core/timeline-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomoreide-timeline-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TimelineStore", () => {
  test("appends, bounds, and persists events", async () => {
    const store = new TimelineStore({ baseDir: dir, maxEvents: 2 });

    await store.append({
      kind: "service.lifecycle",
      severity: "info",
      title: "one",
    });
    await store.append({
      kind: "service.lifecycle",
      severity: "info",
      title: "two",
    });
    await store.append({
      kind: "service.lifecycle",
      severity: "info",
      title: "three",
    });

    expect(store.read().map((event) => event.title)).toEqual(["two", "three"]);
    const raw = await readFile(join(dir, "timeline.log"), "utf8");
    expect(raw).toContain("one");
    expect(raw).toContain("three");
  });
});
