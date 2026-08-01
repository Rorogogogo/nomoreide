/**
 * Publish / install flows between local profiles and the hosted registry.
 * Publish reuses `exportProfile`, so the uploaded package is the same
 * credential-redacted `.tar.gz` a local export produces — raw secrets never
 * leave the machine. Install downloads a published package and runs it
 * through `importProfile` (same validation and credential resolution).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRegistryClient, type RegistryClient } from "./registry-client.js";
import { getProfile, type ProfileStoreOptions } from "./store.js";
import { exportProfile, importProfile, type ImportResult } from "./transfer.js";

export interface PublishProfileInput {
  name: string;
  slug: string;
  title: string;
  summary?: string;
  version?: string;
  changelog?: string;
  visibility?: "public" | "private";
  cwd: string;
  /** Registry API base; the caller resolves it (config/env/default). */
  apiBaseUrl: string;
  /** Pass an authenticated fetch (token manager) or a raw token. */
  token?: string;
  fetch?: typeof fetch;
}

export interface PublishProfileResult {
  slug: string;
  profileId: string;
  versionId: string;
  version: string;
}

export async function publishProfileToRegistry(
  input: PublishProfileInput,
  options: ProfileStoreOptions = {},
): Promise<PublishProfileResult> {
  const version = input.version ?? "1.0.0";
  const client = createRegistryClient({
    baseUrl: input.apiBaseUrl,
    token: input.token,
    fetch: input.fetch,
  });

  const profile = await getProfile(input.name, options);
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "nomoreide-publish-"));
  try {
    const { archivePath } = await exportProfile(
      { name: input.name, outputPath: path.join(tmpRoot, `${input.name}.tar.gz`), cwd: input.cwd },
      options,
    );
    const bytes = await readFile(archivePath);

    let registryProfile = await client.getProfileBySlug(input.slug);
    if (!registryProfile) {
      registryProfile = await client.createProfile({
        slug: input.slug,
        title: input.title,
        summary: input.summary,
        visibility: input.visibility,
      });
    }

    const registryVersion = await client.createProfileVersion({
      profileId: registryProfile.id,
      version,
      changelog: input.changelog,
      manifestJson: {
        name: input.slug,
        version,
        ...(profile.description ? { description: profile.description } : {}),
        mcps: Object.entries(profile.mcps).map(([name, entry]) => ({ name, kind: entry.kind })),
        skills: profile.skills.map((skill) => ({ name: skill.name })),
        plugins: profile.plugins.map((plugin) => ({
          name: plugin.name,
          sourceAgent: plugin.sourceAgent,
          source: plugin.source,
          version: plugin.version,
        })),
      },
    });

    await client.uploadPackage({
      profileId: registryProfile.id,
      versionId: registryVersion.id,
      bytes,
      mimeType: "application/gzip",
    });
    await client.publishProfileVersion({
      profileId: registryProfile.id,
      versionId: registryVersion.id,
    });

    return {
      slug: input.slug,
      profileId: registryProfile.id,
      versionId: registryVersion.id,
      version,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

export interface InstallFromRegistryInput {
  slug: string;
  apiBaseUrl: string;
  token?: string;
  force?: boolean;
  /** Import under a different local profile name. */
  as?: string;
  credentials?: Record<string, string>;
  fetch?: typeof fetch;
  /** Injectable for tests. */
  client?: RegistryClient;
}

export interface InstallFromRegistryResult extends ImportResult {
  version: string;
  sourceKind: string;
}

export async function installProfileFromRegistry(
  input: InstallFromRegistryInput,
  options: ProfileStoreOptions = {},
): Promise<InstallFromRegistryResult> {
  const slug = input.slug.trim();
  if (!slug) throw new Error("Registry slug is required.");

  const fetchImpl = input.fetch ?? fetch;
  const client =
    input.client ??
    createRegistryClient({ baseUrl: input.apiBaseUrl, token: input.token, fetch: fetchImpl });

  const descriptor = await client.getInstallDescriptor(slug);
  if (!descriptor.download_url) {
    throw new Error(`Registry profile "${slug}" has no downloadable package.`);
  }

  const response = await fetchImpl(descriptor.download_url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Download failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  const dir = await mkdtemp(path.join(tmpdir(), "nomoreide-registry-install-"));
  try {
    const archivePath = path.join(dir, `${slug}-${descriptor.version}.tar.gz`);
    await writeFile(archivePath, bytes);
    const result = await importProfile(
      {
        archivePath,
        force: input.force,
        as: input.as,
        credentials: input.credentials,
      },
      options,
    );
    return { ...result, version: descriptor.version, sourceKind: descriptor.source_kind };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
