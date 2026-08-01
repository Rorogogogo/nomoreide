import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readAllAgentConfigs,
  readAntigravityConfig,
  readClaudeConfig,
  readCodexConfig,
} from "../src/core/agent-env/index.js";

describe("agent-env readers", () => {
  let homeDir: string;
  let cwd: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-agent-env-home-"));
    cwd = await mkdtemp(path.join(os.tmpdir(), "nomoreide-agent-env-cwd-"));
  });

  it("reads local and remote Claude MCPs into separate scope maps", async () => {
    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          global: { type: "stdio", command: "npx", args: ["-y", "global-mcp"] },
        },
        projects: {
          [cwd]: {
            mcpServers: {
              github: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-github"],
              },
              docs: {
                type: "http",
                url: "https://developers.openai.com/mcp",
                headers: { Authorization: "Bearer token" },
              },
            },
          },
        },
      }),
      "utf8",
    );

    const result = await readClaudeConfig({ cwd, homeDir });

    expect(result.exists).toBe(true);
    expect(result.mcpServers).toEqual({
      global: { command: "npx", args: ["-y", "global-mcp"] },
    });
    expect(result.remoteMcpServers).toEqual({});
    expect(result.projectMcpServers).toEqual({
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    });
    expect(result.projectRemoteMcpServers).toEqual({
      docs: {
        transport: "http",
        url: "https://developers.openai.com/mcp",
        headers: { Authorization: "Bearer token" },
      },
    });
  });

  it("reports a missing Claude config as exists=false with empty maps", async () => {
    const result = await readClaudeConfig({ cwd, homeDir });
    expect(result.exists).toBe(false);
    expect(result.mcpServers).toEqual({});
    expect(result.skills).toEqual([]);
  });

  it("reads NoMoreIDE-managed Claude plugins and hides their owned skills", async () => {
    await mkdir(path.join(homeDir, ".claude", "skills", "helper"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "skills", "helper", "SKILL.md"),
      "# helper\n",
      "utf8",
    );
    await mkdir(path.join(homeDir, ".config", "nomoreide"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".config", "nomoreide", "managed-plugins.json"),
      JSON.stringify({
        version: 1,
        agents: {
          claude: [{
            name: "portable-kit",
            source: "market",
            kind: "plugin",
            scope: "user",
            managed: true,
            pluginSkills: ["helper"],
          }],
        },
      }),
      "utf8",
    );

    const result = await readClaudeConfig({ cwd, homeDir });
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "portable-kit",
        source: "market",
        kind: "plugin",
        managed: true,
      }),
    ]);
  });

  it("reads local and remote Codex MCPs from config.toml", async () => {
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      [
        "[mcp_servers.github]",
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-github"]',
        "",
        "[mcp_servers.github.env]",
        'GITHUB_TOKEN = "placeholder"',
        "",
        "[mcp_servers.docs]",
        'url = "https://developers.openai.com/mcp"',
        "",
        "[model]",
        'name = "o4"',
      ].join("\n"),
      "utf8",
    );

    const result = await readCodexConfig({ cwd, homeDir });

    expect(result.exists).toBe(true);
    expect(result.mcpServers).toEqual({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "placeholder" },
      },
    });
    expect(result.remoteMcpServers).toEqual({
      docs: { transport: "http", url: "https://developers.openai.com/mcp" },
    });
  });

  it("reads Codex skills from SKILL.md directories", async () => {
    await mkdir(path.join(homeDir, ".codex", "skills", "commit-push"), { recursive: true });

    const result = await readCodexConfig({ cwd, homeDir });

    expect(result.skills).toEqual([
      {
        name: "commit-push",
        source: "local",
        kind: "skill",
        scope: "user",
        installPath: path.join(homeDir, ".codex", "skills", "commit-push"),
      },
    ]);
  });

  it("reads Codex skills from ~/.agents/skills, deduping the legacy dir and adding project scope", async () => {
    // Standard dir wins on a name collision with the legacy dir.
    await mkdir(path.join(homeDir, ".agents", "skills", "dup"), { recursive: true });
    await mkdir(path.join(homeDir, ".codex", "skills", "dup"), { recursive: true });
    await mkdir(path.join(homeDir, ".agents", "skills", "standard-only"), { recursive: true });
    await mkdir(path.join(homeDir, ".codex", "skills", "legacy-only"), { recursive: true });

    const repo = await mkdtemp(path.join(os.tmpdir(), "nomoreide-agent-env-repo-"));
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(path.join(repo, ".agents", "skills", "project-skill"), { recursive: true });
    const innerCwd = path.join(repo, "sub");
    await mkdir(innerCwd, { recursive: true });

    const result = await readCodexConfig({ cwd: innerCwd, homeDir });
    const byName = Object.fromEntries(result.skills.map((skill) => [skill.name, skill]));

    expect(byName["dup"].installPath).toBe(path.join(homeDir, ".agents", "skills", "dup"));
    expect(byName["standard-only"]).toMatchObject({ scope: "user", kind: "skill" });
    expect(byName["legacy-only"]).toMatchObject({ scope: "user", kind: "skill" });
    expect(byName["project-skill"]).toMatchObject({ scope: "project", kind: "skill" });
    expect(result.skills.filter((skill) => skill.name === "dup")).toHaveLength(1);
  });

  it("discovers Claude project skills via ancestor walk, stopping at the repo root", async () => {
    // Layout: <repo>/.git, <repo>/.claude/skills/project-only, cwd=<repo>/sub/inner.
    // A skill above the repo root must NOT be picked up.
    const outer = await mkdtemp(path.join(os.tmpdir(), "nomoreide-agent-env-outer-"));
    await mkdir(path.join(outer, ".claude", "skills", "outer-skill"), { recursive: true });
    const repo = path.join(outer, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(path.join(repo, ".claude", "skills", "project-only"), { recursive: true });
    const innerCwd = path.join(repo, "sub", "inner");
    await mkdir(innerCwd, { recursive: true });

    await mkdir(path.join(homeDir, ".claude", "skills", "user-only"), { recursive: true });

    const result = await readClaudeConfig({ cwd: innerCwd, homeDir });
    const byName = Object.fromEntries(result.skills.map((skill) => [skill.name, skill]));

    expect(byName["project-only"]).toMatchObject({ scope: "project", kind: "skill" });
    expect(byName["user-only"]).toMatchObject({ scope: "user", kind: "skill" });
    expect(byName["outer-skill"]).toBeUndefined();
  });

  it("reads Antigravity httpUrl/url remotes and treats empty placeholder configs as live", async () => {
    const configDir = path.join(homeDir, ".gemini", "antigravity-cli");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
          docs: { httpUrl: "https://developers.openai.com/mcp" },
          events: { url: "https://mcp.example.com/sse" },
        },
      }),
      "utf8",
    );

    const result = await readAntigravityConfig({ cwd, homeDir });

    expect(result.exists).toBe(true);
    expect(result.mcpServers).toEqual({
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    });
    expect(result.remoteMcpServers).toEqual({
      docs: { transport: "http", url: "https://developers.openai.com/mcp" },
      events: { transport: "sse", url: "https://mcp.example.com/sse" },
    });

    // Empty placeholder at a fallback location still counts as a live config.
    const fallbackHome = await mkdtemp(path.join(os.tmpdir(), "nomoreide-agent-env-fb-"));
    const fallbackPath = path.join(fallbackHome, ".gemini", "config", "mcp_config.json");
    await mkdir(path.dirname(fallbackPath), { recursive: true });
    await writeFile(fallbackPath, "", "utf8");
    const fallback = await readAntigravityConfig({ cwd, homeDir: fallbackHome });
    expect(fallback.exists).toBe(true);
    expect(fallback.configPath).toBe(fallbackPath);
    expect(fallback.mcpServers).toEqual({});
  });

  it("filters MCP servers owned by an installed Claude plugin", async () => {
    const pluginInstall = path.join(homeDir, "plugin-install");
    await mkdir(path.join(pluginInstall, "skills", "review"), { recursive: true });
    await writeFile(
      path.join(pluginInstall, ".mcp.json"),
      JSON.stringify({ mcpServers: { "plugin-owned": { command: "npx" } } }),
      "utf8",
    );
    await mkdir(path.join(homeDir, ".claude", "plugins"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "reviewer@official": [{ installPath: pluginInstall }] },
      }),
      "utf8",
    );
    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "plugin-owned": { command: "npx" },
          standalone: { command: "npx", args: ["-y", "standalone-mcp"] },
        },
      }),
      "utf8",
    );

    const result = await readClaudeConfig({ cwd, homeDir });

    expect(Object.keys(result.mcpServers)).toEqual(["standalone"]);
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "reviewer",
        source: "official",
        kind: "plugin",
        pluginSkills: ["review"],
        pluginMcps: ["plugin-owned"],
      }),
    ]);
  });

  it("reads brainctl-compat project MCPs and managed plugins for codex", async () => {
    await mkdir(path.join(cwd, ".brainctl"), { recursive: true });
    await writeFile(
      path.join(cwd, ".brainctl", "project-mcps.json"),
      JSON.stringify({
        codex: {
          mcpServers: {
            "project-tool": { command: "npx", args: ["-y", "project-tool"] },
            "project-remote": { url: "https://mcp.example.com/mcp", transport: "http" },
          },
        },
      }),
      "utf8",
    );
    await mkdir(path.join(homeDir, ".brainctl"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".brainctl", "managed-plugins.json"),
      JSON.stringify({
        version: 1,
        agents: {
          codex: [{ name: "managed-plugin", scope: "user", pluginSkills: ["helper"] }],
        },
      }),
      "utf8",
    );

    const result = await readCodexConfig({ cwd, homeDir });

    expect(result.projectMcpServers).toEqual({
      "project-tool": { command: "npx", args: ["-y", "project-tool"] },
    });
    expect(result.projectRemoteMcpServers).toEqual({
      "project-remote": { transport: "http", url: "https://mcp.example.com/mcp" },
    });
    expect(result.skills).toEqual([
      expect.objectContaining({ name: "managed-plugin", managed: true, kind: "plugin" }),
    ]);
  });

  it("reads all three agents in one call", async () => {
    const configs = await readAllAgentConfigs({ cwd, homeDir });
    expect(configs.map((config) => config.agent)).toEqual([
      "claude",
      "codex",
      "antigravity",
    ]);
  });
});
