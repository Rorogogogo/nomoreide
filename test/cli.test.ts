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

  test("adds a docker-compose service", async () => {
    const exitCode = await runCli(
      [
        "add",
        "service",
        "api",
        "--kind",
        "docker-compose",
        "--cwd",
        tempDir,
        "--compose-file",
        "docker-compose.yml",
        "--compose-service",
        "api",
        "--port",
        "3001",
      ],
      cliOptions(),
    );

    expect(exitCode).toBe(0);
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw.services[0]).toMatchObject({
      name: "api",
      kind: "docker-compose",
      composeService: "api",
      composeFile: "docker-compose.yml",
    });
  });

  test("adds an ssh service", async () => {
    const exitCode = await runCli(
      [
        "add",
        "service",
        "staging-api",
        "--kind",
        "ssh",
        "--host",
        "devbox",
        "--cwd",
        "/srv/app",
        "--command",
        "npm run dev",
        "--port",
        "3001",
      ],
      cliOptions(),
    );

    expect(exitCode).toBe(0);
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw.services[0]).toMatchObject({
      name: "staging-api",
      kind: "ssh",
      host: "devbox",
      command: "npm run dev",
    });
  });

  test("prints MCP setup commands", async () => {
    const exitCode = await runCli(["setup"], cliOptions());
    const text = output.join("\n");

    expect(exitCode).toBe(0);
    expect(text).toContain(
      "claude mcp add --transport stdio nomoreide -- npx -y nomoreide",
    );
    expect(text).toContain("codex mcp add nomoreide -- npx -y nomoreide");
    expect(text).toContain("~/.gemini/settings.json");
    expect(text).toContain("Prompt to paste into your agent");
    expect(text).toContain("/mcp");
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
