import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../src/cli/commands.js";
import {
  DaemonClient,
  type DaemonConnection,
} from "../src/core/daemon-client.js";
import { createWebServer } from "../src/web/server.js";

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

  test("runs start/stop/logs against the shared daemon", async () => {
    const server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      port: 0,
    }).start();
    const daemon: DaemonConnection = {
      ensure: async () => ({
        status: "already_running",
        url: server.url,
        port: server.port,
        pid: process.pid,
      }),
      client: async () => new DaemonClient(server.url),
      existing: async () => new DaemonClient(server.url),
    };

    try {
      await runCli(
        [
          "add",
          "service",
          "sleeper",
          "--command",
          "node -e 'setInterval(() => {}, 1000)'",
          "--cwd",
          tempDir,
        ],
        cliOptions(daemon),
      );

      output = [];
      expect(await runCli(["start", "sleeper"], cliOptions(daemon))).toBe(0);
      expect(output.join("\n")).toContain('"name": "sleeper"');

      output = [];
      expect(await runCli(["logs", "sleeper"], cliOptions(daemon))).toBe(0);

      output = [];
      expect(await runCli(["stop", "sleeper"], cliOptions(daemon))).toBe(0);
      expect(output.join("\n")).toContain('"state": "stopped"');
    } finally {
      await server.stop();
    }
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

  test("installs the MCP and automatic debugging skill for Codex", async () => {
    const exitCode = await runCli(
      ["setup", "codex"],
      cliOptions(undefined, {
        cwd: tempDir,
        homeDir: tempDir,
      }),
    );

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain(
      "Installed NoMoreIDE debugging for codex: MCP added, skill added",
    );
    const codexConfig = await readFile(join(tempDir, ".codex", "config.toml"), "utf8");
    expect(codexConfig).toContain("[mcp_servers.nomoreide]");
    expect(codexConfig).toContain('command = "npx"');
    const skill = await readFile(
      join(tempDir, ".agents", "skills", "nomoreide-debug", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: nomoreide-debug");
    expect(skill).toContain("nomoreide_start_service");

    output = [];
    expect(
      await runCli(
        ["setup", "codex"],
        cliOptions(undefined, { cwd: tempDir, homeDir: tempDir }),
      ),
    ).toBe(0);
    expect(output.join("\n")).toContain("MCP identical, skill identical");
    expect(output.some((line) => line.startsWith("Backup:"))).toBe(false);
  });

  test("writes Gemini CLI settings rather than Antigravity config", async () => {
    expect(
      await runCli(
        ["setup", "gemini"],
        cliOptions(undefined, { cwd: tempDir, homeDir: tempDir }),
      ),
    ).toBe(0);

    const settings = JSON.parse(
      await readFile(join(tempDir, ".gemini", "settings.json"), "utf8"),
    );
    expect(settings.mcpServers.nomoreide).toEqual({
      command: "npx",
      args: ["-y", "nomoreide"],
    });
    await expect(
      access(join(tempDir, ".gemini", "antigravity-cli", "mcp_config.json")),
    ).rejects.toThrow();
  });

  test("refuses malformed Claude config without changing it", async () => {
    const claudePath = join(tempDir, ".claude.json");
    await writeFile(claudePath, "{ invalid json\n", "utf8");

    expect(
      await runCli(
        ["setup", "claude"],
        cliOptions(undefined, { cwd: tempDir, homeDir: tempDir }),
      ),
    ).toBe(2);
    expect(errors.join("\n")).toContain("invalid JSON");
    expect(await readFile(claudePath, "utf8")).toBe("{ invalid json\n");
    await expect(
      access(join(tempDir, ".claude", "skills", "nomoreide-debug")),
    ).rejects.toThrow();
  });

  test("preserves unrelated Codex MCP fields during setup", async () => {
    const configPath = join(tempDir, ".codex", "config.toml");
    await mkdir(join(tempDir, ".codex"), { recursive: true });
    await writeFile(
      configPath,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.other]",
        'command = "other-mcp"',
        "enabled = false",
        "startup_timeout_sec = 45",
        "",
        "[mcp_servers.other.env]",
        'TOKEN = "keep-me"',
        "",
      ].join("\n"),
      "utf8",
    );

    expect(
      await runCli(
        ["setup", "codex"],
        cliOptions(undefined, { cwd: tempDir, homeDir: tempDir }),
      ),
    ).toBe(0);
    const updated = await readFile(configPath, "utf8");
    expect(updated).toContain('model = "gpt-5"');
    expect(updated).toContain("[mcp_servers.other]");
    expect(updated).toContain("enabled = false");
    expect(updated).toContain("startup_timeout_sec = 45");
    expect(updated).toContain('TOKEN = "keep-me"');
    expect(updated).toContain("[mcp_servers.nomoreide]");
  });

  test("refuses skill conflicts unless forced and preserves a backup", async () => {
    const setupOptions = { cwd: tempDir, homeDir: tempDir };
    expect(await runCli(["setup", "codex"], cliOptions(undefined, setupOptions))).toBe(0);
    const skillPath = join(tempDir, ".agents", "skills", "nomoreide-debug", "SKILL.md");
    await writeFile(skillPath, "custom skill\n", "utf8");

    output = [];
    errors = [];
    expect(await runCli(["setup", "codex"], cliOptions(undefined, setupOptions))).toBe(1);
    expect(errors.join("\n")).toContain("Re-run with --force");
    expect(await readFile(skillPath, "utf8")).toBe("custom skill\n");

    output = [];
    errors = [];
    expect(
      await runCli(["setup", "codex", "--force"], cliOptions(undefined, setupOptions)),
    ).toBe(0);
    expect(output.join("\n")).toContain("MCP identical, skill replaced");
    const backupLine = output.find((line) => line.startsWith("Backup: "));
    expect(backupLine).toBeDefined();
    expect(await readFile(backupLine!.slice("Backup: ".length) + "/SKILL.md", "utf8")).toBe(
      "custom skill\n",
    );
  });

  test("refuses to replace a customized MCP definition unless forced", async () => {
    const setupOptions = { cwd: tempDir, homeDir: tempDir };
    expect(await runCli(["setup", "codex"], cliOptions(undefined, setupOptions))).toBe(0);
    const configPath = join(tempDir, ".codex", "config.toml");
    const customConfig = [
      "[mcp_servers.nomoreide]",
      'command = "node"',
      'args = ["/custom/nomoreide.js"]',
      "",
    ].join("\n");
    await writeFile(configPath, customConfig, "utf8");

    output = [];
    errors = [];
    expect(await runCli(["setup", "codex"], cliOptions(undefined, setupOptions))).toBe(1);
    expect(errors.join("\n")).toContain('MCP server "nomoreide"');
    expect(await readFile(configPath, "utf8")).toBe(customConfig);

    output = [];
    errors = [];
    expect(
      await runCli(["setup", "codex", "--force"], cliOptions(undefined, setupOptions)),
    ).toBe(0);
    expect(output.join("\n")).toContain("MCP replaced, skill identical");
    expect(await readFile(configPath, "utf8")).toContain('command = "npx"');
  });

  test("replaces disabled single-quoted Codex MCP tables without duplication", async () => {
    const setupOptions = { cwd: tempDir, homeDir: tempDir };
    const configPath = join(tempDir, ".codex", "config.toml");
    await mkdir(join(tempDir, ".codex"), { recursive: true });
    await writeFile(
      configPath,
      [
        "[mcp_servers.'nomoreide'] # intentionally disabled",
        'command = "npx"',
        'args = ["-y", "nomoreide"]',
        "enabled = false",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await runCli(["setup", "codex"], cliOptions(undefined, setupOptions))).toBe(1);
    expect(errors.join("\n")).toContain('MCP server "nomoreide"');

    output = [];
    errors = [];
    expect(
      await runCli(["setup", "codex", "--force"], cliOptions(undefined, setupOptions)),
    ).toBe(0);
    const updated = await readFile(configPath, "utf8");
    expect(updated).toContain("[mcp_servers.nomoreide]");
    expect(updated).not.toContain("enabled = false");
    expect(updated.match(/\[mcp_servers\./g)).toHaveLength(1);
  });

  test.each([
    [
      "dotted assignment",
      'mcp_servers.nomoreide = { command = "node", args = ["/custom.js"] }\n',
    ],
    [
      "root MCP table assignment",
      [
        "[mcp_servers]",
        'other = { command = "other-mcp" }',
        'nomoreide = { command = "node", args = ["/custom.js"] }',
        "",
      ].join("\n"),
    ],
  ])("safely replaces a Codex MCP expressed as a %s", async (_label, source) => {
    const setupOptions = { cwd: tempDir, homeDir: tempDir };
    const configPath = join(tempDir, ".codex", "config.toml");
    await mkdir(join(tempDir, ".codex"), { recursive: true });
    await writeFile(configPath, source, "utf8");

    expect(await runCli(["setup", "codex"], cliOptions(undefined, setupOptions))).toBe(1);

    output = [];
    errors = [];
    expect(
      await runCli(["setup", "codex", "--force"], cliOptions(undefined, setupOptions)),
    ).toBe(0);
    const updated = await readFile(configPath, "utf8");
    expect(() => parseToml(updated)).not.toThrow();
    expect(updated).toContain("[mcp_servers.nomoreide]");
    expect(updated).toContain('command = "npx"');
    expect(updated).not.toContain("/custom.js");
    if (source.includes("other-mcp")) expect(updated).toContain("other-mcp");
  });

  test("refuses a Codex MCP layout that cannot be replaced surgically", async () => {
    const setupOptions = { cwd: tempDir, homeDir: tempDir };
    const configPath = join(tempDir, ".codex", "config.toml");
    await mkdir(join(tempDir, ".codex"), { recursive: true });
    const source =
      'mcp_servers = { nomoreide = { command = "custom" }, other = { command = "keep" } }\n';
    await writeFile(configPath, source, "utf8");

    expect(
      await runCli(["setup", "codex", "--force"], cliOptions(undefined, setupOptions)),
    ).toBe(2);
    expect(errors.join("\n")).toContain("unsupported TOML layout");
    expect(await readFile(configPath, "utf8")).toBe(source);
    await expect(
      access(join(tempDir, ".agents", "skills", "nomoreide-debug")),
    ).rejects.toThrow();
  });

  test.each([
    ["claude", ".claude.json", '{"theme":"dark","mcpServers":[]}\n', "mcpServers"],
    ["gemini", join(".gemini", "settings.json"), "[]\n", "JSON object"],
  ] as const)(
    "refuses structurally invalid %s MCP settings without reporting success",
    async (agent, relativePath, source, expectedError) => {
      const configPath = join(tempDir, relativePath);
      await mkdir(join(configPath, ".."), { recursive: true });
      await writeFile(configPath, source, "utf8");

      expect(
        await runCli(
          ["setup", agent],
          cliOptions(undefined, { cwd: tempDir, homeDir: tempDir }),
        ),
      ).toBe(2);
      expect(errors.join("\n")).toContain(expectedError);
      expect(output.join("\n")).not.toContain("Installed NoMoreIDE debugging");
      expect(await readFile(configPath, "utf8")).toBe(source);
      const skillRoot =
        agent === "claude"
          ? join(tempDir, ".claude", "skills", "nomoreide-debug")
          : join(tempDir, ".gemini", "skills", "nomoreide-debug");
      await expect(access(skillRoot)).rejects.toThrow();
    },
  );

  test("detects and backs up a conflicting legacy Codex skill", async () => {
    const setupOptions = { cwd: tempDir, homeDir: tempDir };
    const legacySkillDir = join(tempDir, ".codex", "skills", "nomoreide-debug");
    await mkdir(legacySkillDir, { recursive: true });
    await writeFile(join(legacySkillDir, "SKILL.md"), "custom legacy skill\n", "utf8");

    expect(await runCli(["setup", "codex"], cliOptions(undefined, setupOptions))).toBe(1);
    expect(errors.join("\n")).toContain('skill "nomoreide-debug"');
    expect(await readFile(join(legacySkillDir, "SKILL.md"), "utf8")).toBe(
      "custom legacy skill\n",
    );

    output = [];
    errors = [];
    expect(
      await runCli(["setup", "codex", "--force"], cliOptions(undefined, setupOptions)),
    ).toBe(0);
    const backupLine = output.find((line) => line.startsWith("Backup: "));
    expect(backupLine).toBeDefined();
    expect(await readFile(join(backupLine!.slice("Backup: ".length), "SKILL.md"), "utf8")).toBe(
      "custom legacy skill\n",
    );
    await expect(access(legacySkillDir)).rejects.toThrow();
    await expect(
      access(join(tempDir, ".agents", "skills", "nomoreide-debug", "SKILL.md")),
    ).resolves.toBeUndefined();
  });

  test("backs up standard and legacy Codex skill conflicts separately", async () => {
    const setupOptions = { cwd: tempDir, homeDir: tempDir };
    const standardSkillDir = join(tempDir, ".agents", "skills", "nomoreide-debug");
    const legacySkillDir = join(tempDir, ".codex", "skills", "nomoreide-debug");
    await mkdir(standardSkillDir, { recursive: true });
    await mkdir(legacySkillDir, { recursive: true });
    await writeFile(join(standardSkillDir, "SKILL.md"), "standard custom skill\n", "utf8");
    await writeFile(join(legacySkillDir, "SKILL.md"), "legacy custom skill\n", "utf8");

    expect(
      await runCli(["setup", "codex", "--force"], cliOptions(undefined, setupOptions)),
    ).toBe(0);
    const backupPaths = output
      .filter((line) => line.startsWith("Backup: "))
      .map((line) => line.slice("Backup: ".length));
    expect(backupPaths).toHaveLength(2);
    expect(new Set(backupPaths).size).toBe(2);
    const backupContents = await Promise.all(
      backupPaths.map((backupPath) => readFile(join(backupPath, "SKILL.md"), "utf8")),
    );
    expect(backupContents.sort()).toEqual(
      ["legacy custom skill\n", "standard custom skill\n"].sort(),
    );
  });

  test("rejects an unsupported setup agent", async () => {
    expect(await runCli(["setup", "unknown"], cliOptions())).toBe(1);
    expect(errors.join("\n")).toContain("claude, codex, gemini");
  });
});

function cliOptions(
  daemon?: DaemonConnection,
  overrides: { cwd?: string; homeDir?: string } = {},
) {
  return {
    configPath,
    daemon,
    ...overrides,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
  };
}
