import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyChanges, previewChanges, type PendingChange } from "../src/core/agent-env-actions.js";
import { removePlugin } from "../src/core/agent-env-plugin-uninstall.js";
import { readCodexConfig } from "../src/core/agent-env/index.js";

describe("agent-env plugin uninstall", () => {
  let homeDir: string;
  let cwd: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-plugin-rm-home-"));
    cwd = await mkdtemp(path.join(os.tmpdir(), "nomoreide-plugin-rm-cwd-"));
  });

  const removeChange = (overrides: Partial<PendingChange> = {}): PendingChange => ({
    category: "plugin",
    action: "remove",
    name: "notes",
    sourceAgent: "codex",
    sourceScope: "user",
    ...overrides,
  });

  async function seedCodexNativePlugin(): Promise<string> {
    const installPath = path.join(
      homeDir,
      ".codex",
      "plugins",
      "cache",
      "market",
      "notes",
      "1.0.0",
    );
    await mkdir(path.join(installPath, "skills", "note-taking"), { recursive: true });
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      [
        "[model]",
        'name = "o4"',
        "",
        '[plugins."notes@market"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );
    return installPath;
  }

  it("uninstalls a native Codex plugin: config.toml section stripped, cache dir deleted", async () => {
    const installPath = await seedCodexNativePlugin();
    const live = await readCodexConfig({ cwd, homeDir });
    expect(live.skills.map((skill) => skill.name)).toContain("notes");

    const preview = await previewChanges({ cwd, homeDir, changes: [removeChange()] });
    expect(preview.valid).toBe(true);
    expect(preview.items[0].warnings[0]).toContain("1 skills");
    expect(preview.agents).toEqual([
      { agent: "codex", add: [], remove: ['plugin "notes"'] },
    ]);

    const result = await applyChanges({ cwd, homeDir, changes: [removeChange()] });
    expect(result.ok).toBe(true);
    expect(result.backups.some((backup) => backup.includes("config.toml.bak."))).toBe(true);

    const toml = await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[model]");
    expect(toml).not.toContain('[plugins."notes@market"]');
    await expect(stat(path.dirname(installPath))).rejects.toThrow();

    const after = await readCodexConfig({ cwd, homeDir });
    expect(after.skills.map((skill) => skill.name)).not.toContain("notes");
  });

  it("blocks plugin copy/move and unknown plugins in preview", async () => {
    await seedCodexNativePlugin();
    const preview = await previewChanges({
      cwd,
      homeDir,
      changes: [
        removeChange({ action: "copy", targetAgent: "claude" }),
        removeChange({ name: "ghost" }),
      ],
    });
    expect(preview.valid).toBe(false);
    expect(preview.items[0].error).toContain("marketplace");
    expect(preview.items[1].error).toContain('Plugin "ghost" not found');
  });

  it("uninstalls a brainctl-managed plugin: installed files and registry record removed", async () => {
    // brainctl materialized skills/commands as skill dirs and agents as files.
    await mkdir(path.join(homeDir, ".codex", "skills", "helper"), { recursive: true });
    await mkdir(path.join(homeDir, ".codex", "skills", "helper-cmd"), { recursive: true });
    await mkdir(path.join(homeDir, ".codex", "agents"), { recursive: true });
    await writeFile(path.join(homeDir, ".codex", "agents", "helper-agent.toml"), "", "utf8");
    await writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      ["[mcp_servers.helper-mcp]", 'command = "npx"', ""].join("\n"),
      "utf8",
    );
    await mkdir(path.join(homeDir, ".brainctl"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".brainctl", "managed-plugins.json"),
      JSON.stringify({
        version: 1,
        agents: {
          codex: [
            {
              name: "helper-pack",
              kind: "plugin",
              scope: "user",
              managed: true,
              source: "claude-plugins-official",
              pluginSkills: ["helper"],
              pluginCommands: ["helper-cmd"],
              pluginAgents: ["helper-agent"],
              pluginMcps: ["helper-mcp"],
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await applyChanges({
      cwd,
      homeDir,
      changes: [removeChange({ name: "helper-pack" })],
    });
    expect(result.ok).toBe(true);

    await expect(stat(path.join(homeDir, ".codex", "skills", "helper"))).rejects.toThrow();
    await expect(stat(path.join(homeDir, ".codex", "skills", "helper-cmd"))).rejects.toThrow();
    await expect(
      stat(path.join(homeDir, ".codex", "agents", "helper-agent.toml")),
    ).rejects.toThrow();

    const toml = await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    expect(toml).not.toContain("helper-mcp");

    const registry = JSON.parse(
      await readFile(path.join(homeDir, ".brainctl", "managed-plugins.json"), "utf8"),
    ) as { agents: { codex: unknown[] } };
    expect(registry.agents.codex).toEqual([]);

    const after = await readCodexConfig({ cwd, homeDir });
    expect(after.skills.map((skill) => skill.name)).not.toContain("helper-pack");
  });

  it("delegates native Claude plugin uninstall to the claude CLI", async () => {
    const runClaudeCli = vi.fn().mockResolvedValue(undefined);
    await removePlugin({
      cwd,
      homeDir,
      agent: "claude",
      plugin: {
        name: "reviewer",
        source: "official",
        kind: "plugin",
        scope: "user",
        installPath: "/anywhere/reviewer/1.0.0",
      },
      runClaudeCli,
    });
    expect(runClaudeCli).toHaveBeenCalledWith([
      "plugin",
      "uninstall",
      "reviewer@official",
      "--scope",
      "user",
    ]);
  });

  it("refuses to delete Codex plugin files outside the plugins cache", async () => {
    await expect(
      removePlugin({
        cwd,
        homeDir,
        agent: "codex",
        plugin: {
          name: "evil",
          source: "market",
          kind: "plugin",
          scope: "user",
          installPath: path.join(homeDir, "important-data"),
        },
      }),
    ).rejects.toThrow(/outside/);
  });
});
