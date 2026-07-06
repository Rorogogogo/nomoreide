import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  profileSkillsDir,
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

  it("snapshots an agent's live MCPs and user skills, excluding plugins", async () => {
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

    const profile = await snapshotProfileFromAgent(
      { agent: "claude", name: "claude-backup", cwd },
      opts(),
    );

    expect(profile.mcps.github).toEqual({
      kind: "local",
      command: "npx",
      args: ["-y", "server-github"],
    });
    expect(profile.mcps.docs).toMatchObject({ kind: "remote", transport: "http" });
    expect(profile.skills).toEqual([{ name: "commit-push" }]);
    await expect(
      readFile(path.join(profileSkillsDir("claude-backup", opts()), "commit-push", "SKILL.md"), "utf8"),
    ).resolves.toContain("commit-push");
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
