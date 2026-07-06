/**
 * Portable profile archives (`.tar.gz`). Export redacts secret-looking env
 * and header values into `${credentials.<key>}` placeholders — raw secrets
 * never enter an archive. Import resolves placeholders from supplied
 * credentials / the process environment and reports what's still missing.
 *
 * Archive layout: `manifest.json` + `profile.json` + `skills/<name>/…`.
 * Tarballs are produced with the system `tar` (present on macOS, Linux, and
 * Windows 10+), matching what brainctl shipped.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  findUnresolvedCredentialKeys,
  redactMcpCredentials,
  resolveMcpCredentials,
} from "./credentials.js";
import {
  getProfile,
  pathExists,
  profileDir,
  profileSkillsDir,
  writeProfile,
  type ProfileStoreOptions,
} from "./store.js";
import {
  profileManifestSchema,
  profileSchema,
  type CredentialSpec,
  type Profile,
  type ProfileManifest,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ExportResult {
  archivePath: string;
  /** Credentials that were redacted; the importer must supply these. */
  credentials: CredentialSpec[];
}

export async function exportProfile(
  input: { name: string; outputPath?: string; cwd: string },
  options: ProfileStoreOptions = {},
): Promise<ExportResult> {
  const profile = await getProfile(input.name, options);
  const stagingDir = await mkdtemp(path.join(tmpdir(), "nomoreide-profile-pack-"));

  try {
    const credentials = new Map<string, CredentialSpec>();
    const redactedMcps = Object.fromEntries(
      Object.entries(profile.mcps).map(([key, config]) => {
        const result = redactMcpCredentials(config);
        for (const spec of result.credentials) credentials.set(spec.key, spec);
        return [key, result.redacted];
      }),
    );

    const manifest: ProfileManifest = {
      schemaVersion: 1,
      profileName: profile.name,
      createdBy: { tool: "nomoreide", version: await packageVersion() },
      ...(credentials.size > 0 ? { credentials: Array.from(credentials.values()) } : {}),
    };

    await writeFile(
      path.join(stagingDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(stagingDir, "profile.json"),
      JSON.stringify({ ...profile, mcps: redactedMcps }, null, 2) + "\n",
      "utf8",
    );

    for (const skill of profile.skills) {
      const sourceDir = path.join(profileSkillsDir(input.name, options), path.basename(skill.name));
      if (!(await pathExists(sourceDir))) continue;
      const target = path.join(stagingDir, "skills", path.basename(skill.name));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(sourceDir, target, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return base !== ".git" && base !== ".DS_Store";
        },
      });
    }

    const archivePath = input.outputPath ?? path.join(input.cwd, `${profile.name}.tar.gz`);
    await mkdir(path.dirname(archivePath), { recursive: true });
    await execFileAsync("tar", ["-czf", archivePath, "-C", stagingDir, "."]);

    return { archivePath, credentials: Array.from(credentials.values()) };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export interface ImportResult {
  name: string;
  mcpCount: number;
  skillCount: number;
  /** Credential keys the caller still has to fill in (placeholders kept). */
  missingCredentials: CredentialSpec[];
}

export async function importProfile(
  input: {
    archivePath: string;
    force?: boolean;
    credentials?: Record<string, string>;
    /** Override the imported profile's name (e.g. on collision). */
    as?: string;
  },
  options: ProfileStoreOptions = {},
): Promise<ImportResult> {
  if (!(await pathExists(input.archivePath))) {
    throw new Error(`Archive not found: ${input.archivePath}`);
  }

  const extractDir = await mkdtemp(path.join(tmpdir(), "nomoreide-profile-import-"));
  try {
    try {
      await execFileAsync("tar", ["-xzf", input.archivePath, "-C", extractDir]);
    } catch {
      throw new Error("Could not extract the archive — is it a .tar.gz profile export?");
    }

    const manifest = profileManifestSchema.safeParse(
      JSON.parse(await readFile(path.join(extractDir, "manifest.json"), "utf8")),
    );
    if (!manifest.success) {
      throw new Error("Archive has a missing or invalid manifest.json — not a nomoreide profile archive.");
    }
    const parsedProfile = profileSchema.safeParse(
      JSON.parse(await readFile(path.join(extractDir, "profile.json"), "utf8")),
    );
    if (!parsedProfile.success) {
      throw new Error("Archive has a missing or invalid profile.json.");
    }

    const name = input.as ?? parsedProfile.data.name;
    const profile: Profile = { ...parsedProfile.data, name };
    if (!input.force && (await pathExists(path.join(profileDir(name, options), "profile.json")))) {
      throw new Error(`Profile "${name}" already exists. Re-import with force to overwrite.`);
    }

    const missing = new Map<string, CredentialSpec>();
    profile.mcps = Object.fromEntries(
      Object.entries(profile.mcps).map(([key, config]) => {
        const result = resolveMcpCredentials(config, {
          credentials: input.credentials,
          credentialSpecs: manifest.data.credentials,
          environment: process.env,
        });
        for (const spec of result.missing) missing.set(spec.key, spec);
        return [key, result.resolved];
      }),
    );

    await writeProfile(profile, options);

    let skillCount = 0;
    for (const skill of profile.skills) {
      const sourceDir = path.join(extractDir, "skills", path.basename(skill.name));
      if (!(await pathExists(sourceDir))) continue;
      const target = path.join(profileSkillsDir(name, options), path.basename(skill.name));
      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      await cp(sourceDir, target, { recursive: true });
      skillCount += 1;
    }

    // Anything a spec listed but resolution didn't reach (or that remains as
    // a placeholder in the stored profile) counts as missing.
    for (const key of findUnresolvedCredentialKeys(profile.mcps)) {
      if (!missing.has(key)) {
        missing.set(key, { key, required: true, description: `Credential ${key} is required` });
      }
    }

    return {
      name,
      mcpCount: Object.keys(profile.mcps).length,
      skillCount,
      missingCredentials: Array.from(missing.values()),
    };
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

let cachedVersion: string | undefined;

async function packageVersion(): Promise<string> {
  if (!cachedVersion) {
    try {
      const pkg = JSON.parse(
        await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      ) as { version?: string };
      cachedVersion = pkg.version ?? "0.0.0";
    } catch {
      cachedVersion = "0.0.0";
    }
  }
  return cachedVersion;
}
