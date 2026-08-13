import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyProfile,
  createProfile,
  deleteProfile,
  exportProfile,
  getProfile,
  importProfile,
  listProfiles,
  previewProfileApply,
  profilePluginsDir,
  profileSkillsDir,
  refreshProfileFromAgent,
  redactMcpCredentials,
  resolveMcpCredentials,
  snapshotProfileFromAgent,
  updateProfile,
  type ProfileMcp,
} from "../src/core/agent-profiles/index.js";
import { readClaudeConfig, readCodexConfig } from "../src/core/agent-env/index.js";

describe("agent-profiles credentials", () => {
  it("redacts secret-looking env and header values into placeholders", () => {
    const result = redactMcpCredentials({
      kind: "remote",
      transport: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer sk-live-12345", Accept: "application/json" },
      env: { GITHUB_TOKEN: "ghp_secret", apiKey: "raw-key", LOG_LEVEL: "debug" },
    });

    expect(result.redacted.env).toEqual({
      GITHUB_TOKEN: "${credentials.github_token}",
      apiKey: "${credentials.api_key}",
      LOG_LEVEL: "debug",
    });
    expect(result.redacted.kind === "remote" && result.redacted.headers).toEqual({
      Authorization: "${credentials.authorization}",
      Accept: "application/json",
    });
    expect(result.rawValues).toEqual({
      github_token: "ghp_secret",
      api_key: "raw-key",
      authorization: "Bearer sk-live-12345",
    });
    expect(result.credentials.map((spec) => spec.key)).toEqual([
      "api_key",
      "authorization",
      "github_token",
    ]);
  });

  it("keeps existing placeholders as-is and out of rawValues", () => {
    const result = redactMcpCredentials({
      kind: "local",
      command: "npx",
      env: { API_TOKEN: "${credentials.api_token}" },
    });
    expect(result.redacted.env).toEqual({ API_TOKEN: "${credentials.api_token}" });
    expect(result.rawValues).toEqual({});
  });

  it("resolves placeholders from credentials or the environment, keeping Bearer prefixes", () => {
    const config: ProfileMcp = {
      kind: "remote",
      transport: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer ${credentials.authorization}" },
      env: { GITHUB_TOKEN: "${credentials.github_token}", MISSING_TOKEN: "${credentials.missing_token}" },
    };

    const result = resolveMcpCredentials(config, {
      credentials: { authorization: "sk-new" },
      environment: { github_token: "ghp_from_env" },
    });

    expect(result.resolved.kind === "remote" && result.resolved.headers).toEqual({
      Authorization: "Bearer sk-new",
    });
    expect(result.resolved.env).toEqual({
      GITHUB_TOKEN: "ghp_from_env",
      MISSING_TOKEN: "${credentials.missing_token}",
    });
    expect(result.missing.map((spec) => spec.key)).toEqual(["missing_token"]);
  });
});

describe("agent-profiles store + transfer + apply", () => {
  let homeDir: string;
  let cwd: string;
  const opts = () => ({ homeDir });

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-profiles-home-"));
    cwd = await mkdtemp(path.join(os.tmpdir(), "nomoreide-profiles-cwd-"));
  });

  it("does CRUD round-trips and cleans dropped skill dirs", async () => {
    await createProfile({ name: "dev", description: "Dev setup" }, opts());
    await expect(createProfile({ name: "dev" }, opts())).rejects.toThrow("already exists");
    await expect(createProfile({ name: "bad name!" }, opts())).rejects.toThrow("Invalid profile name");

    const skillDir = path.join(profileSkillsDir("dev", opts()), "helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# helper\n", "utf8");

    await updateProfile(
      "dev",
      {
        mcps: { github: { kind: "local", command: "npx", args: ["-y", "server-github"] } },
        skills: [{ name: "helper" }],
      },
      opts(),
    );

    const listed = await listProfiles(opts());
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "dev", mcpCount: 1, skillCount: 1 });

    // Dropping the skill from the manifest removes its bundled dir.
    await updateProfile("dev", { skills: [] }, opts());
    await expect(stat(skillDir)).rejects.toThrow();

    await deleteProfile("dev", opts());
    await expect(getProfile("dev", opts())).rejects.toThrow("not found");
  });

  it("keeps the existing profile when refreshing from an unavailable agent fails", async () => {
    await createProfile({ name: "safe", description: "Keep me" }, opts());
    await updateProfile(
      "safe",
      { mcps: { docs: { kind: "remote", transport: "http", url: "https://example.com/mcp" } } },
      opts(),
    );

    await expect(
      refreshProfileFromAgent({ agent: "antigravity", name: "safe", cwd }, opts()),
    ).rejects.toThrow("no live config");

    await expect(getProfile("safe", opts())).resolves.toMatchObject({
      name: "safe",
      description: "Keep me",
      mcps: { docs: { kind: "remote", url: "https://example.com/mcp" } },
    });
    expect(await listProfiles(opts())).toHaveLength(1);
  });

  it("snapshots an agent's live MCPs, user skills, and self-contained plugins", async () => {
    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          github: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
          docs: { type: "http", url: "https://docs.example.com/mcp" },
        },
      }),
      "utf8",
    );
    const skillDir = path.join(homeDir, ".claude", "skills", "commit-push");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# commit-push\n", "utf8");
    const pluginDir = path.join(
      homeDir,
      ".claude",
      "plugins",
      "cache",
      "official",
      "review-tools",
      "1.2.3",
    );
    await mkdir(path.join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(path.join(pluginDir, "skills", "review", "SKILL.md"), "# review\n", "utf8");
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "review-tools@official": [{ installPath: pluginDir, version: "1.2.3" }],
        },
      }),
      "utf8",
    );

    const profile = await snapshotProfileFromAgent(
      { agent: "claude", name: "claude-backup", description: "Team setup", cwd },
      opts(),
    );

    expect(profile.mcps.github).toEqual({
      kind: "local",
      command: "npx",
      args: ["-y", "server-github"],
    });
    expect(profile.mcps.docs).toMatchObject({ kind: "remote", transport: "http" });
    expect(profile.skills).toEqual([{ name: "commit-push" }]);
    expect(profile.plugins).toHaveLength(1);
    expect(profile.plugins[0]).toMatchObject({
      name: "review-tools",
      source: "official",
      sourceAgent: "claude",
      pluginSkills: ["review"],
    });
    await expect(
      readFile(
        path.join(
          profilePluginsDir("claude-backup", opts()),
          profile.plugins[0].bundleKey,
          "skills",
          "review",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("review");
    await expect(
      readFile(path.join(profileSkillsDir("claude-backup", opts()), "commit-push", "SKILL.md"), "utf8"),
    ).resolves.toContain("commit-push");

    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { linear: { command: "npx", args: ["linear-mcp"] } } }),
      "utf8",
    );
    const refreshed = await refreshProfileFromAgent(
      { agent: "claude", name: "claude-backup", cwd },
      opts(),
    );

    expect(refreshed).toMatchObject({
      name: "claude-backup",
      description: "Team setup",
      sourceAgent: "claude",
    });
    expect(refreshed.mcps).toEqual({
      linear: { kind: "local", command: "npx", args: ["linear-mcp"] },
    });
    expect(await listProfiles(opts())).toHaveLength(1);
  });

  it("materializes a linked skill when snapshotting an agent", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-linked-skill-"));
    await writeFile(path.join(sourceDir, "SKILL.md"), "# linked helper\n", "utf8");
    const liveSkillsDir = path.join(homeDir, ".claude", "skills");
    await mkdir(liveSkillsDir, { recursive: true });
    await symlink(sourceDir, path.join(liveSkillsDir, "linked-helper"));

    const profile = await snapshotProfileFromAgent(
      { agent: "claude", name: "linked-snapshot", cwd },
      opts(),
    );

    expect(profile.skills).toEqual([{ name: "linked-helper" }]);
    const storedDir = path.join(profileSkillsDir(profile.name, opts()), "linked-helper");
    expect((await lstat(storedDir)).isSymbolicLink()).toBe(false);
    await expect(readFile(path.join(storedDir, "SKILL.md"), "utf8")).resolves.toBe(
      "# linked helper\n",
    );
  });

  it("round-trips plugin bundles and restores native or managed targets on apply", async () => {
    const pluginDir = path.join(
      homeDir,
      ".claude",
      "plugins",
      "cache",
      "official",
      "review-tools",
      "1.2.3",
    );
    await mkdir(path.join(pluginDir, "skills", "review"), { recursive: true });
    await mkdir(path.join(pluginDir, "commands"), { recursive: true });
    await writeFile(path.join(pluginDir, "skills", "review", "SKILL.md"), "# review\n", "utf8");
    await writeFile(path.join(pluginDir, "commands", "summarize.md"), "# summarize\n", "utf8");
    await writeFile(
      path.join(pluginDir, ".mcp.json"),
      JSON.stringify({
        review: {
          command: "node",
          args: ["server.js"],
          env: { GITHUB_TOKEN: "plugin-secret-token" },
        },
        docs: {
          type: "http",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: "Bearer plugin-remote-secret" },
        },
      }),
      "utf8",
    );
    await mkdir(path.join(homeDir, ".claude", "plugins"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "review-tools@official": [{ installPath: pluginDir, version: "1.2.3" }],
        },
      }),
      "utf8",
    );
    await snapshotProfileFromAgent(
      { agent: "claude", name: "plugin-kit", cwd },
      opts(),
    );
    const archivePath = path.join(cwd, "plugin-kit.tar.gz");
    const exported = await exportProfile(
      { name: "plugin-kit", outputPath: archivePath, cwd },
      opts(),
    );
    expect(exported.credentials.map((entry) => entry.key)).toContain("github_token");
    expect(exported.credentials.map((entry) => entry.key)).toContain("authorization");
    const inspectDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-plugin-archive-"));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("tar", ["-xzf", archivePath, "-C", inspectDir]);
    const archivedPlugin = await readFile(
      path.join(
        inspectDir,
        "plugins",
        (await getProfile("plugin-kit", opts())).plugins[0].bundleKey,
        ".mcp.json",
      ),
      "utf8",
    );
    expect(archivedPlugin).not.toContain("plugin-secret-token");
    expect(archivedPlugin).not.toContain("plugin-remote-secret");
    expect(archivedPlugin).toContain("${credentials.github_token}");
    expect(archivedPlugin).toContain("${credentials.authorization}");

    const importedHome = await mkdtemp(path.join(os.tmpdir(), "nomoreide-plugin-import-"));
    const importedResult = await importProfile(
      {
        archivePath,
        credentials: {
          github_token: "restored-plugin-token",
          authorization: "restored-remote-token",
        },
      },
      { homeDir: importedHome },
    );
    expect(importedResult.pluginCount).toBe(1);
    expect(
      await getProfile("plugin-kit", { homeDir: importedHome }),
    ).toMatchObject({ plugins: [{ name: "review-tools", sourceAgent: "claude" }] });

    const native = await applyProfile({
      cwd,
      homeDir: importedHome,
      name: "plugin-kit",
      agent: "claude",
    });
    expect(native.pluginsApplied).toEqual(["review-tools"]);
    const nativeRegistry = JSON.parse(
      await readFile(
        path.join(importedHome, ".claude", "plugins", "installed_plugins.json"),
        "utf8",
      ),
    );
    expect(nativeRegistry.plugins["review-tools@official"][0].installPath).toContain(
      "/.claude/plugins/cache/official/review-tools/1.2.3",
    );

    const managedHome = await mkdtemp(path.join(os.tmpdir(), "nomoreide-plugin-managed-"));
    await importProfile(
      {
        archivePath,
        credentials: {
          github_token: "managed-plugin-token",
          authorization: "managed-remote-token",
        },
      },
      { homeDir: managedHome },
    );
    const preview = await previewProfileApply({
      cwd,
      homeDir: managedHome,
      name: "plugin-kit",
      agent: "codex",
    });
    expect(preview.items.find((item) => item.category === "plugin")).toMatchObject({
      name: "review-tools",
      status: "add",
    });
    expect(
      preview.items.find((item) => item.category === "plugin")?.warnings[0],
    ).toContain("portable assets");

    const managed = await applyProfile({
      cwd,
      homeDir: managedHome,
      name: "plugin-kit",
      agent: "codex",
    });
    expect(managed.pluginsApplied).toEqual(["review-tools"]);
    await expect(
      readFile(path.join(managedHome, ".agents", "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toContain("review");
    await expect(
      readFile(path.join(managedHome, ".agents", "skills", "summarize", "SKILL.md"), "utf8"),
    ).resolves.toContain("summarize");
    const live = await readCodexConfig({ cwd, homeDir: managedHome });
    expect(
      live.skills.find((entry) => entry.kind === "plugin" && entry.name === "review-tools"),
    ).toMatchObject({ managed: true, pluginMcps: ["review", "docs"] });
    expect(
      await readFile(path.join(managedHome, ".codex", "config.toml"), "utf8"),
    ).toContain("[mcp_servers.review]");
    expect(
      await readFile(path.join(managedHome, ".codex", "config.toml"), "utf8"),
    ).toContain('GITHUB_TOKEN = "managed-plugin-token"');
    expect(
      await readFile(path.join(managedHome, ".codex", "config.toml"), "utf8"),
    ).toContain('url = "https://docs.example.com/mcp"');

    await deleteProfile("plugin-kit", { homeDir: managedHome });
    const resnapshot = await snapshotProfileFromAgent(
      { agent: "codex", name: "plugin-kit-resnapshot", cwd },
      { homeDir: managedHome },
    );
    expect(resnapshot.plugins).toMatchObject([
      { name: "review-tools", managed: true, pluginMcps: ["review", "docs"] },
    ]);
  });

  it("previews collisions from managed plugin skills, commands, and MCPs", async () => {
    await mkdir(path.join(homeDir, ".agents", "skills", "review"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".agents", "skills", "review", "SKILL.md"),
      "# standalone review\n",
      "utf8",
    );
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      ['[mcp_servers.shared]', 'command = "existing"', ""].join("\n"),
      "utf8",
    );
    await createProfile({ name: "collision-kit" }, opts());
    const bundleKey = "collision-plugin";
    const pluginDir = path.join(profilePluginsDir("collision-kit", opts()), bundleKey);
    await mkdir(path.join(pluginDir, "skills", "review"), { recursive: true });
    await writeFile(path.join(pluginDir, "skills", "review", "SKILL.md"), "# plugin\n", "utf8");
    await updateProfile(
      "collision-kit",
      {
        plugins: [{
          name: "collision-plugin",
          sourceAgent: "claude",
          source: "official",
          bundleKey,
          pluginSkills: ["review"],
          pluginCommands: ["review"],
          pluginMcps: ["shared"],
        }],
      },
      opts(),
    );

    const preview = await previewProfileApply({
      cwd,
      homeDir,
      name: "collision-kit",
      agent: "codex",
    });
    const plugin = preview.items.find((item) => item.category === "plugin");
    expect(plugin?.status).toBe("conflict");
    expect(plugin?.warnings.join("\n")).toContain('skill "review"');
    expect(plugin?.warnings.join("\n")).toContain('MCP "shared"');
  });

  it("round-trips export → import with credentials redacted in the archive", async () => {
    await createProfile({ name: "secure" }, opts());
    const skillDir = path.join(profileSkillsDir("secure", opts()), "helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# helper\n", "utf8");
    await updateProfile(
      "secure",
      {
        mcps: {
          github: {
            kind: "local",
            command: "npx",
            args: ["-y", "server-github"],
            env: { GITHUB_TOKEN: "ghp_super_secret" },
          },
        },
        skills: [{ name: "helper" }],
      },
      opts(),
    );

    const exported = await exportProfile(
      { name: "secure", outputPath: path.join(cwd, "secure.tar.gz"), cwd },
      opts(),
    );
    expect(exported.credentials.map((spec) => spec.key)).toEqual(["github_token"]);

    // The raw secret must not appear anywhere in the archive.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const extractDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-profiles-extract-"));
    await promisify(execFile)("tar", ["-xzf", exported.archivePath, "-C", extractDir]);
    const archivedProfile = await readFile(path.join(extractDir, "profile.json"), "utf8");
    expect(archivedProfile).not.toContain("ghp_super_secret");
    expect(archivedProfile).toContain("${credentials.github_token}");
    const manifest = JSON.parse(await readFile(path.join(extractDir, "manifest.json"), "utf8"));
    expect(manifest.credentials[0].key).toBe("github_token");

    // Import into a fresh home, supplying the credential.
    const otherHome = await mkdtemp(path.join(os.tmpdir(), "nomoreide-profiles-home2-"));
    const result = await importProfile(
      { archivePath: exported.archivePath, credentials: { github_token: "ghp_new_value" } },
      { homeDir: otherHome },
    );
    expect(result).toMatchObject({ name: "secure", mcpCount: 1, skillCount: 1, missingCredentials: [] });
    const imported = await getProfile("secure", { homeDir: otherHome });
    expect(imported.mcps.github).toMatchObject({ env: { GITHUB_TOKEN: "ghp_new_value" } });

    // Importing without credentials keeps the placeholder and reports it.
    const thirdHome = await mkdtemp(path.join(os.tmpdir(), "nomoreide-profiles-home3-"));
    const unresolved = await importProfile(
      { archivePath: exported.archivePath },
      { homeDir: thirdHome },
    );
    expect(unresolved.missingCredentials.map((spec) => spec.key)).toEqual(["github_token"]);

    // Same name collides unless forced.
    await expect(
      importProfile({ archivePath: exported.archivePath }, { homeDir: otherHome }),
    ).rejects.toThrow("already exists");
    await expect(
      importProfile({ archivePath: exported.archivePath, force: true }, { homeDir: otherHome }),
    ).resolves.toMatchObject({ name: "secure" });
  });

  it("exports linked skill directories and files as portable content", async () => {
    await createProfile({ name: "linked" }, opts());

    const externalSkill = await mkdtemp(path.join(os.tmpdir(), "nomoreide-external-skill-"));
    await writeFile(path.join(externalSkill, "SKILL.md"), "# root link\n", "utf8");
    await mkdir(profileSkillsDir("linked", opts()), { recursive: true });
    await symlink(externalSkill, path.join(profileSkillsDir("linked", opts()), "root-link"));

    const nestedSkill = path.join(profileSkillsDir("linked", opts()), "nested-link");
    await mkdir(nestedSkill, { recursive: true });
    const externalFile = path.join(cwd, "SKILL.md");
    await writeFile(externalFile, "# nested link\n", "utf8");
    await symlink(externalFile, path.join(nestedSkill, "SKILL.md"));
    const internalDocs = path.join(nestedSkill, "docs");
    await mkdir(internalDocs, { recursive: true });
    await writeFile(path.join(internalDocs, "guide.md"), "portable docs\n", "utf8");
    await symlink(internalDocs, path.join(nestedSkill, "linked-docs"));

    await updateProfile(
      "linked",
      { skills: [{ name: "root-link" }, { name: "nested-link" }] },
      opts(),
    );

    const archivePath = path.join(cwd, "linked.tar.gz");
    await exportProfile({ name: "linked", outputPath: archivePath, cwd }, opts());
    const listing = await promisify(execFile)("tar", ["-tvzf", archivePath]);
    expect(listing.stdout.split("\n").filter(Boolean).every((line) => !/^[lh]/.test(line))).toBe(
      true,
    );

    const importedHome = await mkdtemp(path.join(os.tmpdir(), "nomoreide-linked-import-"));
    await expect(importProfile({ archivePath }, { homeDir: importedHome })).resolves.toMatchObject({
      name: "linked",
      skillCount: 2,
    });
    const importedSkills = profileSkillsDir("linked", { homeDir: importedHome });
    expect((await lstat(path.join(importedSkills, "root-link"))).isSymbolicLink()).toBe(false);
    expect((await lstat(path.join(importedSkills, "nested-link", "SKILL.md"))).isSymbolicLink()).toBe(
      false,
    );
    expect((await lstat(path.join(importedSkills, "nested-link", "linked-docs"))).isSymbolicLink()).toBe(
      false,
    );
    await expect(readFile(path.join(importedSkills, "root-link", "SKILL.md"), "utf8")).resolves.toBe(
      "# root link\n",
    );
    await expect(
      readFile(path.join(importedSkills, "nested-link", "SKILL.md"), "utf8"),
    ).resolves.toBe("# nested link\n");
    await expect(
      readFile(path.join(importedSkills, "nested-link", "linked-docs", "guide.md"), "utf8"),
    ).resolves.toBe("portable docs\n");
  });

  it("refuses to export a profile with a broken bundled skill link", async () => {
    await createProfile({ name: "broken-link" }, opts());
    const skillDir = path.join(profileSkillsDir("broken-link", opts()), "helper");
    await mkdir(skillDir, { recursive: true });
    await symlink(path.join(cwd, "missing-SKILL.md"), path.join(skillDir, "SKILL.md"));
    await updateProfile("broken-link", { skills: [{ name: "helper" }] }, opts());

    const archivePath = path.join(cwd, "broken-link.tar.gz");
    await writeFile(archivePath, "previous valid export", "utf8");
    await expect(
      exportProfile({ name: "broken-link", outputPath: archivePath, cwd }, opts()),
    ).rejects.toThrow('Could not export bundled skill "helper".');
    await expect(readFile(archivePath, "utf8")).resolves.toBe("previous valid export");
  });

  it("refuses to export a nested link that escapes the skill bundle", async () => {
    await createProfile({ name: "escaping-link" }, opts());
    const skillDir = path.join(profileSkillsDir("escaping-link", opts()), "helper");
    await mkdir(skillDir, { recursive: true });
    const externalFile = path.join(cwd, ".env");
    await writeFile(externalFile, "SECRET=do-not-publish\n", "utf8");
    await symlink(externalFile, path.join(skillDir, "notes.txt"));
    await updateProfile("escaping-link", { skills: [{ name: "helper" }] }, opts());

    const archivePath = path.join(cwd, "escaping-link.tar.gz");
    await expect(
      exportProfile({ name: "escaping-link", outputPath: archivePath, cwd }, opts()),
    ).rejects.toThrow('Could not export bundled skill "helper".');
    await expect(stat(archivePath)).rejects.toThrow();
  });

  it("previews add/identical/conflict and applies with skips + backups", async () => {
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      ["[mcp_servers.github]", 'command = "npx"', 'args = ["-y", "server-github"]', ""].join("\n"),
      "utf8",
    );

    await createProfile({ name: "team" }, opts());
    const skillDir = path.join(profileSkillsDir("team", opts()), "helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# helper\n", "utf8");
    await updateProfile(
      "team",
      {
        mcps: {
          github: { kind: "local", command: "npx", args: ["-y", "server-github"] }, // identical
          linear: { kind: "local", command: "npx", args: ["-y", "linear-mcp"] }, // add
          docs: { kind: "remote", transport: "sse", url: "https://docs.example.com/sse" }, // codex warning
        },
        skills: [{ name: "helper" }],
      },
      opts(),
    );

    const preview = await previewProfileApply({ cwd, homeDir, name: "team", agent: "codex" });
    const byName = Object.fromEntries(preview.items.map((item) => [item.name, item]));
    expect(byName.github.status).toBe("identical");
    expect(byName.linear.status).toBe("add");
    expect(byName.helper.status).toBe("add");
    expect(byName.docs.warnings[0]).toContain("transport and headers will be dropped");

    const result = await applyProfile({
      cwd,
      homeDir,
      name: "team",
      agent: "codex",
      skip: { mcps: ["docs"] },
    });
    expect(result.mcpsApplied.sort()).toEqual(["github", "linear"]);
    expect(result.skillsApplied).toEqual(["helper"]);
    expect(result.skipped).toEqual(['mcp "docs"']);
    expect(result.backups.length).toBeGreaterThan(0);

    const live = await readCodexConfig({ cwd, homeDir });
    expect(live.mcpServers.linear).toEqual({ command: "npx", args: ["-y", "linear-mcp"] });
    expect(live.remoteMcpServers.docs).toBeUndefined();
    expect(live.skills.map((skill) => skill.name)).toContain("helper");

    // The same skill now conflicts on a re-preview.
    const again = await previewProfileApply({ cwd, homeDir, name: "team", agent: "codex" });
    expect(again.items.find((item) => item.name === "helper")?.status).toBe("conflict");

    // Applying to claude with no prior config also works (fresh file).
    const claudeResult = await applyProfile({ cwd, homeDir, name: "team", agent: "claude" });
    expect(claudeResult.mcpsApplied).toContain("docs");
    const claude = await readClaudeConfig({ cwd, homeDir });
    expect(claude.remoteMcpServers.docs).toMatchObject({ transport: "sse" });
  });
});

describe("profile archive rejection messages", () => {
  const execFileAsync = promisify(execFile);

  /** Builds a .tar.gz whose top-level members are exactly `files`. */
  async function makeArchive(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-archive-"));
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, name), contents, "utf8");
    }
    const archivePath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "nomoreide-archive-out-")),
      "profile.tar.gz",
    );
    await execFileAsync("tar", ["-czf", archivePath, "-C", dir, "."]);
    return archivePath;
  }

  it("names the brainctl YAML layout instead of blaming the file format", async () => {
    const archivePath = await makeArchive({
      "manifest.yaml": "name: legacy\n",
      "profile.yaml": "name: legacy\n",
    });
    await expect(importProfile({ archivePath })).rejects.toThrow(/brainctl-era/);
  });

  it("reports an unsafe path rather than the generic extraction error", async () => {
    const archivePath = await makeArchive({ "evil.sh": "#!/bin/sh\n" });
    await expect(importProfile({ archivePath })).rejects.toThrow(/unsafe path/);
  });

  it("identifies a rejected link entry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-archive-link-"));
    await writeFile(path.join(dir, "manifest.json"), "{}\n", "utf8");
    await symlink("manifest.json", path.join(dir, "profile.json"));
    const archivePath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "nomoreide-archive-out-")),
      "profile.tar.gz",
    );
    await execFileAsync("tar", ["-czf", archivePath, "-C", dir, "."]);

    await expect(importProfile({ archivePath })).rejects.toThrow(
      "Profile archive contains a link entry, which is not allowed: ./profile.json",
    );
  });

  it("still reports a genuinely unreadable file as an extraction failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-archive-bad-"));
    const archivePath = path.join(dir, "not-really.tar.gz");
    await writeFile(archivePath, "this is not a gzip stream", "utf8");
    await expect(importProfile({ archivePath })).rejects.toThrow(/Could not extract the archive/);
  });
});
