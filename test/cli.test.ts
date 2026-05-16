import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../src/cli/commands.js";

let tempDir: string;
let configPath: string;
let output: string[];
let errors: string[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-cli-"));
  configPath = join(tempDir, "nomoreide.config.json");
  output = [];
  errors = [];
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("CLI commands", () => {
  test("adds and lists a service", async () => {
    const exitCode = await runCli(
      [
        "add",
        "service",
        "backend",
        "--command",
        "npm run dev",
        "--cwd",
        tempDir,
        "--port",
        "3001",
      ],
      cliOptions(),
    );

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("Registered service backend");

    output = [];
    await runCli(["list"], cliOptions());

    expect(output.join("\n")).toContain("backend");
    expect(output.join("\n")).toContain("3001");
  });

  test("adds a bundle", async () => {
    const exitCode = await runCli(
      ["add", "bundle", "full-stack", "backend", "frontend"],
      cliOptions(),
    );

    expect(exitCode).toBe(0);
    const raw = JSON.parse(await readFile(configPath, "utf8"));

    expect(raw.bundles).toEqual([
      { name: "full-stack", services: ["backend", "frontend"] },
    ]);
  });

  test("returns a usage error for missing required service flags", async () => {
    const exitCode = await runCli(["add", "service", "backend"], cliOptions());

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--command is required");
  });
});

function cliOptions() {
  return {
    configPath,
    logDir: join(tempDir, "logs"),
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
  };
}
