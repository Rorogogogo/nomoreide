import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyClientFilters,
  buildDockerArgs,
  buildJournaldArgs,
  LogSourceError,
  readLogSource,
} from "../src/core/log-sources.js";
import type { LogEntry } from "../src/core/types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-logsrc-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("readLogSource", () => {
  test("tails the last N lines of a local file", async () => {
    const path = join(tempDir, "app.log");
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    await writeFile(path, `${lines.join("\n")}\n`);

    const entries = await readLogSource({ name: "local", kind: "file", path }, { lines: 3 });

    expect(entries.map((e) => e.text)).toEqual(["line 8", "line 9", "line 10"]);
    expect(entries.every((e) => e.service === "local")).toBe(true);
  });

  test("applies a grep filter to a file source client-side", async () => {
    const path = join(tempDir, "grep.log");
    await writeFile(path, "alpha\nbeta\ngamma beta\n");

    const entries = await readLogSource({ name: "g", kind: "file", path }, { grep: "beta" });

    expect(entries.map((e) => e.text)).toEqual(["beta", "gamma beta"]);
  });

  test("flags error-looking lines as stderr so they render red", async () => {
    const path = join(tempDir, "mixed.log");
    await writeFile(path, "all good\nERROR: boom\nstill fine\n");

    const entries = await readLogSource({ name: "local", kind: "file", path });

    expect(entries.find((e) => e.text.includes("boom"))?.stream).toBe("stderr");
    expect(entries.find((e) => e.text === "all good")?.stream).toBe("stdout");
  });

  test("runs a command source and captures its output", async () => {
    const entries = await readLogSource({
      name: "echo",
      kind: "command",
      command: "printf 'one\\ntwo\\n'",
    });

    expect(entries.map((e) => e.text)).toEqual(["one", "two"]);
  });

  test("raises a friendly error for a missing file", async () => {
    await expect(
      readLogSource({ name: "gone", kind: "file", path: join(tempDir, "nope.log") }),
    ).rejects.toBeInstanceOf(LogSourceError);
  });

  test("requires a unit for a journald driver source", async () => {
    await expect(
      readLogSource({ name: "svc", kind: "command", driver: "journald" }),
    ).rejects.toBeInstanceOf(LogSourceError);
  });

  test("requires a container for a docker driver source", async () => {
    await expect(
      readLogSource({ name: "svc", kind: "command", driver: "docker" }),
    ).rejects.toBeInstanceOf(LogSourceError);
  });
});

describe("buildJournaldArgs", () => {
  test("tails N lines with no query", () => {
    expect(buildJournaldArgs("jobjourney", {}, 200)).toEqual([
      "journalctl", "-u", "jobjourney", "--no-pager", "-o", "json", "-n", "200",
    ]);
  });

  test("pushes time range, grep, and level down to journalctl", () => {
    const args = buildJournaldArgs("jobjourney", { since: "today", grep: "boom", level: "error" }, 500);
    expect(args).toContain("--since");
    expect(args[args.indexOf("--since") + 1]).toBe("today");
    expect(args).toContain("--grep");
    expect(args[args.indexOf("--grep") + 1]).toBe("boom");
    expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "err"]);
  });

  test("pages newer with an --after-cursor", () => {
    const args = buildJournaldArgs("jobjourney", { cursor: "s=abc" }, 500);
    expect(args.slice(args.indexOf("--after-cursor"), args.indexOf("--after-cursor") + 2)).toEqual([
      "--after-cursor",
      "s=abc",
    ]);
    expect(args).not.toContain("--reverse");
  });

  test("pages older with --cursor --reverse", () => {
    const args = buildJournaldArgs("jobjourney", { before: "s=xyz" }, 200);
    expect(args).toContain("--reverse");
    expect(args.slice(args.indexOf("--cursor"), args.indexOf("--cursor") + 2)).toEqual([
      "--cursor",
      "s=xyz",
    ]);
    expect(args.slice(args.indexOf("-n"), args.indexOf("-n") + 2)).toEqual(["-n", "200"]);
  });
});

describe("buildDockerArgs", () => {
  test("tails with timestamps and a time window", () => {
    const args = buildDockerArgs("brainctl-api", { since: "1h" }, 100);
    expect(args).toEqual([
      "docker", "logs", "--tail", "100", "--timestamps", "--since", "1h", "brainctl-api",
    ]);
  });
});

describe("applyClientFilters", () => {
  const entries: LogEntry[] = [
    { service: "s", stream: "stdout", text: "starting up", timestamp: "" },
    { service: "s", stream: "stdout", text: "WARNING: low disk", timestamp: "" },
    { service: "s", stream: "stderr", text: "ERROR: boom", timestamp: "" },
  ];

  test("level=error keeps only error-ish lines", () => {
    expect(applyClientFilters(entries, { level: "error" }).map((e) => e.text)).toEqual(["ERROR: boom"]);
  });

  test("level=warn keeps warnings and errors", () => {
    expect(applyClientFilters(entries, { level: "warn" }).map((e) => e.text)).toEqual([
      "WARNING: low disk",
      "ERROR: boom",
    ]);
  });

  test("falls back to a literal match for an invalid regex", () => {
    const lines: LogEntry[] = [{ service: "s", stream: "stdout", text: "a[b", timestamp: "" }];
    expect(applyClientFilters(lines, { grep: "a[b" }).map((e) => e.text)).toEqual(["a[b"]);
  });
});
