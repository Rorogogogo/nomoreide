import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../src/cli/commands.js";

let tempDir: string;
let configPath: string;
let realHome: string | undefined;
let output: string[];
let errors: string[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-cli-agents-"));
  configPath = join(tempDir, "nomoreide.config.json");
  output = [];
  errors = [];
  // The agents/profile commands resolve os.homedir() — point it at the fixture.
  realHome = process.env.HOME;
  process.env.HOME = tempDir;
});

afterEach(async () => {
  process.env.HOME = realHome;
  await rm(tempDir, { recursive: true, force: true });
});

const cliOptions = () => ({
  configPath,
  logDir: join(tempDir, "logs"),
  stdout: (line: string) => output.push(line),
  stderr: (line: string) => errors.push(line),
});

async function seedClaudeConfig(): Promise<void> {
  await writeFile(
    join(tempDir, ".claude.json"),
    JSON.stringify({
      mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "server-github"] } },
    }),
    "utf8",
  );
  const skillDir = join(tempDir, ".claude", "skills", "commit-push");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# commit-push\n", "utf8");
}

describe("nomoreide agents", () => {
  test("status lists each agent with MCP and skill counts", async () => {
    await seedClaudeConfig();
    const exitCode = await runCli(["agents", "status"], cliOptions());
    expect(exitCode).toBe(0);
    // Availability and project-skill count depend on the host machine — only
    // pin the user-scope MCP count seeded by the fixture.
    const claudeRow = output.find((line) => line.startsWith("claude\t"));
    expect(claudeRow).toMatch(/^claude\t(yes|no)\t1\t\d+\t/);
    expect(output.some((line) => line.startsWith("codex\t"))).toBe(true);
    expect(output.some((line) => line.startsWith("antigravity\t"))).toBe(true);
  });

  test("read <agent> dumps a single config as JSON", async () => {
    await seedClaudeConfig();
    const exitCode = await runCli(["agents", "read", "claude"], cliOptions());
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output.join("\n"));
    expect(parsed.agent).toBe("claude");
    expect(parsed.mcpServers.github.command).toBe("npx");
  });

  test("rejects unknown agents and subcommands with a usage error", async () => {
    expect(await runCli(["agents", "read", "cursor"], cliOptions())).toBe(1);
    expect(errors.join("\n")).toContain("Unknown agent");
    expect(await runCli(["agents", "bogus"], cliOptions())).toBe(1);
  });
});

describe("nomoreide profile", () => {
  test("snapshot → list → show → export → import → delete round-trip", async () => {
    await seedClaudeConfig();

    expect(await runCli(["profile", "snapshot", "claude", "dev-kit"], cliOptions())).toBe(0);
    expect(output.join("\n")).toContain('Snapshotted claude into "dev-kit" (1 MCPs, 1 skills)');

    output = [];
    expect(await runCli(["profile", "list"], cliOptions())).toBe(0);
    expect(output.join("\n")).toContain("dev-kit\t1\t1");

    output = [];
    expect(await runCli(["profile", "show", "dev-kit"], cliOptions())).toBe(0);
    expect(JSON.parse(output.join("\n")).name).toBe("dev-kit");

    output = [];
    const archivePath = join(tempDir, "dev-kit.tar.gz");
    expect(
      await runCli(["profile", "export", "dev-kit", "--output", archivePath], cliOptions()),
    ).toBe(0);
    expect(output.join("\n")).toContain(archivePath);

    output = [];
    expect(
      await runCli(["profile", "import", archivePath, "--as", "copy"], cliOptions()),
    ).toBe(0);
    expect(output.join("\n")).toContain('Imported "copy"');

    output = [];
    expect(await runCli(["profile", "delete", "copy"], cliOptions())).toBe(0);
    expect(output.join("\n")).toContain('Deleted profile "copy"');
  });

  test("apply --dry-run previews items without touching the agent config", async () => {
    await seedClaudeConfig();
    await runCli(["profile", "snapshot", "claude", "dev-kit"], cliOptions());

    output = [];
    const exitCode = await runCli(
      ["profile", "apply", "dev-kit", "codex", "--dry-run"],
      cliOptions(),
    );
    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("mcp github\tadd");
  });

  test("requires arguments and reports usage errors", async () => {
    expect(await runCli(["profile", "show"], cliOptions())).toBe(1);
    expect(errors.join("\n")).toContain("profile name is required");
    expect(await runCli(["profile", "snapshot", "cursor", "x"], cliOptions())).toBe(1);
    expect(errors.join("\n")).toContain("agent is required");
    expect(await runCli(["profile", "publish", "dev-kit"], cliOptions())).toBe(1);
    expect(errors.join("\n")).toContain("--slug and --title are required");
  });
});
