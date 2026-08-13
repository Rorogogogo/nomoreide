/**
 * HTTP client for the hosted profile registry (the brainctl platform).
 * Thin wrapper over its REST API: profile CRUD, version + package upload,
 * publish, install descriptors, and GitHub-repo registration. Auth is the
 * caller's job — pass a token or an already-authenticated `fetch`.
 */

export interface RegistryProfile {
  id: string;
  slug: string;
  title: string;
  summary: string;
}

export interface RegistryProfileVersion {
  id: string;
  profile_id: string;
  version: string;
}

export type RegistryProfileSort = "recent" | "stars" | "downloads" | "alpha";

export interface RegistryPublicProfile {
  id: string;
  slug: string;
  title: string;
  summary: string;
  stars_count: number;
  downloads_count: number;
  author?: {
    id: string;
    display_name?: string | null;
    avatar_url?: string | null;
  } | null;
  source: {
    kind: string;
    github_repo_url?: string | null;
    github_stars_count?: number | null;
  };
  latest_version: {
    id: string;
    profile_id: string;
    version: string;
    changelog: string;
    manifest_json: Record<string, unknown>;
    created_at: string;
    published_at?: string | null;
  };
}

export interface RegistryInstallDescriptor {
  slug: string;
  version: string;
  /** `"brainctl"` is the pre-rename spelling of `"hosted"`. */
  source_kind: "hosted" | "brainctl" | "github" | string;
  download_url: string;
  checksum_sha256?: string | null;
}

export interface RegisterGithubProfileInput {
  repoUrl: string;
  slug: string;
  title: string;
  summary?: string;
  refName?: string;
  profilePath?: string;
  manifestJson: Record<string, unknown>;
}

export interface RegistryClient {
  listPublicProfiles(input?: {
    query?: string;
    sort?: RegistryProfileSort;
  }): Promise<RegistryPublicProfile[]>;
  getProfileBySlug(slug: string): Promise<RegistryProfile | null>;
  createProfile(input: {
    slug: string;
    title: string;
    summary?: string;
    visibility?: "public" | "private";
  }): Promise<RegistryProfile>;
  createProfileVersion(input: {
    profileId: string;
    version: string;
    changelog?: string;
    manifestJson: Record<string, unknown>;
  }): Promise<RegistryProfileVersion>;
  uploadPackage(input: {
    profileId: string;
    versionId: string;
    bytes: Uint8Array;
    mimeType?: string;
  }): Promise<unknown>;
  publishProfileVersion(input: { profileId: string; versionId: string }): Promise<unknown>;
  getInstallDescriptor(slug: string): Promise<RegistryInstallDescriptor>;
  registerGithubProfile(input: RegisterGithubProfileInput): Promise<unknown>;
}

export function createRegistryClient(options: {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}): RegistryClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const authHeaders: Record<string, string> = options.token
    ? { authorization: `Bearer ${options.token}` }
    : {};
  const jsonHeaders = { "content-type": "application/json", ...authHeaders };

  async function failIfNotOk(response: Response, action: string): Promise<void> {
    if (response.ok) return;
    const text = await response.text().catch(() => "");
    throw new Error(`${action} failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`);
  }

  return {
    async listPublicProfiles(input = {}) {
      const url = new URL(`${baseUrl}/profiles`);
      const query = input.query?.trim();
      if (query) url.searchParams.set("q", query);
      if (input.sort && input.sort !== "recent") {
        url.searchParams.set("sort", input.sort);
      }
      const response = await fetchImpl(url, { headers: authHeaders });
      await failIfNotOk(response, "List profiles");
      return (await response.json()) as RegistryPublicProfile[];
    },

    async getProfileBySlug(slug) {
      const response = await fetchImpl(`${baseUrl}/profiles/${slug}`, {
        headers: authHeaders,
      });
      if (response.status === 404) return null;
      await failIfNotOk(response, "Lookup profile");
      return (await response.json()) as RegistryProfile;
    },

    async createProfile(input) {
      const response = await fetchImpl(`${baseUrl}/profiles`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          slug: input.slug,
          title: input.title,
          summary: input.summary ?? "",
          visibility: input.visibility ?? "public",
        }),
      });
      await failIfNotOk(response, "Create profile");
      return (await response.json()) as RegistryProfile;
    },

    async createProfileVersion(input) {
      const response = await fetchImpl(`${baseUrl}/profiles/${input.profileId}/versions`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          version: input.version,
          changelog: input.changelog ?? "",
          manifest_json: input.manifestJson,
        }),
      });
      await failIfNotOk(response, "Create profile version");
      return (await response.json()) as RegistryProfileVersion;
    },

    async uploadPackage(input) {
      const response = await fetchImpl(
        `${baseUrl}/profiles/${input.profileId}/versions/${input.versionId}/package`,
        {
          method: "POST",
          headers: { "content-type": input.mimeType ?? "application/gzip", ...authHeaders },
          body: input.bytes,
        },
      );
      await failIfNotOk(response, "Upload package");
      return response.json();
    },

    async publishProfileVersion(input) {
      const response = await fetchImpl(
        `${baseUrl}/profiles/${input.profileId}/versions/${input.versionId}/publish`,
        { method: "POST", headers: authHeaders },
      );
      await failIfNotOk(response, "Publish profile version");
      return response.json();
    },

    async getInstallDescriptor(slug) {
      const response = await fetchImpl(`${baseUrl}/profiles/${slug}/install`, {
        headers: authHeaders,
      });
      await failIfNotOk(response, "Read install descriptor");
      return (await response.json()) as RegistryInstallDescriptor;
    },

    async registerGithubProfile(input) {
      const response = await fetchImpl(`${baseUrl}/profiles/github/register`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          repo_url: input.repoUrl,
          slug: input.slug,
          title: input.title,
          summary: input.summary ?? "",
          ref_name: input.refName ?? "main",
          profile_path: input.profilePath ?? "profile.yaml",
          manifest_json: input.manifestJson,
        }),
      });
      await failIfNotOk(response, "Register GitHub profile");
      return response.json();
    },
  };
}
