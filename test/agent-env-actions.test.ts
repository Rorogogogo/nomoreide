import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyChanges,
  previewChanges,
  snapshotAgent,
  type PendingChange,
} from "../src/core/agent-env-actions.js";
import {
  readAllAgentConfigs,
  readAntigravityConfig,
  readClaudeConfig,
  readCodexConfig,
} from "../src/core/agent-env/index.js";

describe("agent-env staged writes", () => {
  let homeDir: string;
  let cwd: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-agent-actions-home-"));
    cwd = await mkdtemp(path.join(os.tmpdir(), "nomoreide-agent-actions-cwd-"));
  });

  const change = (overrides: Partial<PendingChange>): PendingChange => ({
    category: "mcp",
    action: "copy",
    name: "github",
    sourceAgent: "claude",
    sourceScope: "user",
    ...overrides,
  });

  async function seedClaude(): Promise<void> {
    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          github: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
          docs: { type: "http", url: "https://docs.example.com/mcp", headers: { A: "b" } },
        },
      }),
      "utf8",
    );
  }

  it("round-trips a Claude MCP copy to Codex (read → stage → apply → re-read)", async () => {
    await seedClaude();
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      ['[model]', 'name = "o4"', ""].join("\n"),
      "utf8",
    );

    const changes = [change({ targetAgent: "codex", targetScope: "user" })];
    const preview = await previewChanges({ cwd, homeDir, changes });
    expect(preview.valid).toBe(true);
    expect(preview.agents).toEqual([{ agent: "codex", add: ['mcp "github"'], remove: [] }]);

    const result = await applyChanges({ cwd, homeDir, changes });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.backups).toHaveLength(1); // codex config existed → backed up

    const codex = await readCodexConfig({ cwd, homeDir });
    expect(codex.mcpServers.github).toEqual({ command: "npx", args: ["-y", "server-github"] });
    // Non-MCP TOML content survives the rebuild.
    const toml = await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[model]");
    // Source is untouched by a copy.
    const claude = await readClaudeConfig({ cwd, homeDir });
    expect(claude.mcpServers.github).toBeDefined();
  });

  it("round-trips a Claude MCP move to Antigravity, backing up both sides", async () => {
    await seedClaude();
    const antigravityDir = path.join(homeDir, ".gemini", "antigravity-cli");
    await mkdir(antigravityDir, { recursive: true });
    await writeFile(path.join(antigravityDir, "mcp_config.json"), JSON.stringify({ mcpServers: {} }), "utf8");

    const changes = [
      change({ action: "move", name: "docs", targetAgent: "antigravity", targetScope: "user" }),
    ];
    const result = await applyChanges({ cwd, homeDir, changes });
    expect(result.ok).toBe(true);
    expect(result.backups).toHaveLength(2); // antigravity add + claude remove

    const antigravity = await readAntigravityConfig({ cwd, homeDir });
    expect(antigravity.remoteMcpServers.docs).toMatchObject({
      transport: "http",
      url: "https://docs.example.com/mcp",
    });
    const claude = await readClaudeConfig({ cwd, homeDir });
    expect(claude.remoteMcpServers.docs).toBeUndefined();
    for (const backup of result.backups) {
      await expect(stat(backup)).resolves.toBeDefined();
    }
  });

  it("moves a Claude MCP between user and project scope with distinct backups", async () => {
    await seedClaude();
    const changes = [
      change({
        action: "move",
        sourceScope: "user",
        targetAgent: "claude",
        targetScope: "project",
      }),
    ];
    const result = await applyChanges({ cwd, homeDir, changes });
    expect(result.ok).toBe(true);
    // add + remove both rewrite ~/.claude.json in the same second; the
    // collision-proof backup names must not overwrite each other.
    expect(new Set(result.backups).size).toBe(2);

    const claude = await readClaudeConfig({ cwd, homeDir });
    expect(claude.mcpServers.github).toBeUndefined();
    expect(claude.projectMcpServers.github).toEqual({ command: "npx", args: ["-y", "server-github"] });

    // The first backup still holds the original state (github in user scope).
    const original = JSON.parse(await readFile(result.backups[0], "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(original.mcpServers.github).toBeDefined();
  });

  it("writes project-scoped Codex MCPs to the brainctl-compat file", async () => {
    await seedClaude();
    const changes = [change({ targetAgent: "codex", targetScope: "project" })];
    const result = await applyChanges({ cwd, homeDir, changes });
    expect(result.ok).toBe(true);

    const codex = await readCodexConfig({ cwd, homeDir });
    expect(codex.projectMcpServers.github).toEqual({ command: "npx", args: ["-y", "server-github"] });
    const raw = JSON.parse(
      await readFile(path.join(cwd, ".brainctl", "project-mcps.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw.codex).toBeDefined();
  });

  it("round-trips a skill copy and a skill move, backing up removed dirs centrally", async () => {
    const skillDir = path.join(homeDir, ".claude", "skills", "commit-push");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# commit-push\n", "utf8");

    const copied = await applyChanges({
      cwd,
      homeDir,
      changes: [
        change({ category: "skill", action: "copy", name: "commit-push", targetAgent: "codex" }),
      ],
    });
    expect(copied.ok).toBe(true);
    const codex = await readCodexConfig({ cwd, homeDir });
    expect(codex.skills.map((skill) => skill.name)).toContain("commit-push");

    const moved = await applyChanges({
      cwd,
      homeDir,
      changes: [
        change({ category: "skill", action: "move", name: "commit-push", targetAgent: "antigravity" }),
      ],
    });
    expect(moved.ok).toBe(true);
    expect(moved.backups).toHaveLength(1);
    expect(moved.backups[0]).toContain(path.join(".config", "nomoreide", "agent-env-backups"));
    await expect(
      readFile(path.join(moved.backups[0], "SKILL.md"), "utf8"),
    ).resolves.toContain("commit-push");

    const claude = await readClaudeConfig({ cwd, homeDir });
    expect(claude.skills.map((skill) => skill.name)).not.toContain("commit-push");
    const antigravity = await readAntigravityConfig({ cwd, homeDir });
    expect(antigravity.skills.map((skill) => skill.name)).toContain("commit-push");
    // Central backup dir must not leak pseudo-skills into any agent's list.
    const skillLists = (await readAllAgentConfigs({ cwd, homeDir })).flatMap((config) =>
      config.skills.map((skill) => skill.name),
    );
    expect(skillLists.filter((name) => name.includes(".bak"))).toEqual([]);
  });

  it("rejects invalid batches in preview and applies nothing", async () => {
    await seedClaude();
    const before = await readFile(path.join(homeDir, ".claude.json"), "utf8");

    const changes = [
      change({ targetAgent: "codex" }), // valid
      change({ name: "missing", action: "remove" }), // source does not exist
    ];
    const preview = await previewChanges({ cwd, homeDir, changes });
    expect(preview.valid).toBe(false);
    expect(preview.items[0].ok).toBe(true);
    expect(preview.items[1].error).toContain('MCP "missing" not found');

    const result = await applyChanges({ cwd, homeDir, changes });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(0);
    expect(await readFile(path.join(homeDir, ".claude.json"), "utf8")).toBe(before);
    // Codex config was never created either.
    await expect(stat(path.join(homeDir, ".codex", "config.toml"))).rejects.toThrow();
  });

  it("validates target rules: plugins, project skills, self-targets, codex remote warning", async () => {
    await seedClaude();
    await mkdir(path.join(homeDir, ".claude", "skills", "local-skill"), { recursive: true });
    await mkdir(path.join(homeDir, ".claude", "plugins"), { recursive: true });
    const pluginInstall = path.join(homeDir, "plugin-install");
    await mkdir(path.join(pluginInstall, "skills", "review"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "reviewer@official": [{ installPath: pluginInstall }] } }),
      "utf8",
    );

    const preview = await previewChanges({
      cwd,
      homeDir,
      changes: [
        change({ category: "skill", name: "reviewer", targetAgent: "codex" }),
        change({ category: "skill", name: "local-skill", targetAgent: "codex", targetScope: "project" }),
        change({ targetAgent: "claude", targetScope: "user" }),
        change({ name: "docs", targetAgent: "codex" }),
      ],
    });

    expect(preview.items[0].error).toContain("plugin");
    expect(preview.items[1].error).toContain("no project-scoped skills");
    expect(preview.items[2].error).toContain("Source and target are the same");
    expect(preview.items[3].ok).toBe(true);
    expect(preview.items[3].warnings[0]).toContain("transport and headers will be dropped");
  });

  it("snapshots an agent's config file to a .bak copy", async () => {
    await seedClaude();
    const result = await snapshotAgent({ cwd, homeDir, agent: "claude" });
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]).toContain(".claude.json.bak.");
    const files = await readdir(homeDir);
    expect(files.some((name) => name.startsWith(".claude.json.bak."))).toBe(true);

    // No config → nothing to back up, but not an error.
    const empty = await snapshotAgent({ cwd, homeDir, agent: "codex" });
    expect(empty.backups).toEqual([]);
  });
});
