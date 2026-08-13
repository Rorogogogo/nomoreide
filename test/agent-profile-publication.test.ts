import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createProfile,
  exportProfile,
  getProfileRegistryDiff,
  importProfile,
  listProfiles,
  profileDir,
  profileSkillsDir,
  readProfileRegistryLink,
  refreshProfileFromAgent,
  updateProfile,
  writeProfileRegistryLink,
} from "../src/core/agent-profiles/index.js";

describe("profile registry publication metadata", () => {
  let homeDir: string;
  let cwd: string;
  const options = () => ({ homeDir });

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-publication-home-"));
    cwd = await mkdtemp(path.join(os.tmpdir(), "nomoreide-publication-cwd-"));
  });

  it("shows a linked version and detects secret-safe local changes", async () => {
    await createProfile({ name: "team-kit", description: "Initial" }, options());
    await updateProfile(
      "team-kit",
      {
        mcps: {
          github: {
            kind: "local",
            command: "npx",
            env: { GITHUB_TOKEN: "ghp_super_secret" },
          },
        },
      },
      options(),
    );
    await writeProfileRegistryLink(
      "team-kit",
      { origin: "published", slug: "team-kit", version: "1.0.0" },
      options(),
    );

    expect((await listProfiles(options()))[0]?.registry).toMatchObject({
      origin: "published",
      slug: "team-kit",
      version: "1.0.0",
      hasLocalChanges: false,
    });
    const sidecar = await readFile(path.join(profileDir("team-kit", options()), "registry.json"), "utf8");
    expect(sidecar).not.toContain("ghp_super_secret");

    await updateProfile(
      "team-kit",
      {
        description: "Changed",
        mcps: {
          github: { kind: "local", command: "pnpm" },
          docs: { kind: "remote", transport: "http", url: "https://example.com/mcp" },
        },
      },
      options(),
    );

    expect((await listProfiles(options()))[0]?.registry?.hasLocalChanges).toBe(true);
    await expect(getProfileRegistryDiff("team-kit", options())).resolves.toMatchObject({
      diff: {
        hasLocalChanges: true,
        descriptionChanged: true,
        mcps: { added: ["docs"], removed: [], changed: ["github"] },
      },
    });
  });

  it("treats a corrupt sidecar as unlinked without hiding the profile", async () => {
    await createProfile({ name: "safe" }, options());
    await writeFile(path.join(profileDir("safe", options()), "registry.json"), "not-json", "utf8");

    expect(await readProfileRegistryLink("safe", options())).toBeNull();
    const profiles = await listProfiles(options());
    expect(profiles).toEqual([expect.objectContaining({ name: "safe" })]);
    expect(profiles[0]).not.toHaveProperty("registry");
  });

  it("clears stale publication ownership during a normal archive import", async () => {
    await createProfile({ name: "source", description: "From archive" }, options());
    const archivePath = path.join(cwd, "source.tar.gz");
    await exportProfile({ name: "source", outputPath: archivePath, cwd }, options());

    await createProfile({ name: "target", description: "Old local copy" }, options());
    await writeProfileRegistryLink(
      "target",
      { origin: "published", slug: "old-owner", version: "9" },
      options(),
    );
    await importProfile({ archivePath, as: "target", force: true }, options());

    expect(await readProfileRegistryLink("target", options())).toBeNull();
  });

  it("includes bundled skill file changes in the baseline digest", async () => {
    await createProfile({ name: "skill-kit" }, options());
    const skillDirectory = path.join(profileSkillsDir("skill-kit", options()), "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), "# Review\n", "utf8");
    await updateProfile("skill-kit", { skills: [{ name: "review" }] }, options());
    await writeProfileRegistryLink(
      "skill-kit",
      { origin: "installed", slug: "review-kit", version: "1" },
      options(),
    );

    await writeFile(path.join(skillDirectory, "SKILL.md"), "# Review\nUpdated\n", "utf8");
    await expect(getProfileRegistryDiff("skill-kit", options())).resolves.toMatchObject({
      diff: { hasLocalChanges: true, skills: { changed: ["review"] } },
    });
  });

  it("preserves the registry link when refreshing from an agent", async () => {
    await createProfile({ name: "refreshable", description: "Keep this" }, options());
    await writeProfileRegistryLink(
      "refreshable",
      { origin: "published", slug: "refreshable", version: "1.0.0" },
      options(),
    );
    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } },
      }),
      "utf8",
    );

    await refreshProfileFromAgent(
      { agent: "claude", name: "refreshable", cwd },
      options(),
    );

    await expect(readProfileRegistryLink("refreshable", options())).resolves.toMatchObject({
      origin: "published",
      slug: "refreshable",
      version: "1.0.0",
    });
    expect((await listProfiles(options()))[0]?.registry?.hasLocalChanges).toBe(true);
  });
});
