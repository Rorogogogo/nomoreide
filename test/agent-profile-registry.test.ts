import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createProfile,
  createRegistryClient,
  createRegistryConfigService,
  createRegistryTokenManager,
  exportProfile,
  getProfile,
  installProfileFromRegistry,
  profileSkillsDir,
  publishProfileToRegistry,
  readProfileRegistryLink,
  resolveRegistryApiTarget,
  resolveRegistryApiToken,
  resolveRegistryFrontendUrl,
  updateProfile,
} from "../src/core/agent-profiles/index.js";

describe("registry public catalog", () => {
  it("lists public profiles with encoded search and sort parameters", async () => {
    let requestedUrl = "";
    const client = createRegistryClient({
      baseUrl: "https://api.example.com/",
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json([
          {
            id: "profile-1",
            slug: "review-stack",
            title: "Review Stack",
            summary: "Review tools",
            stars_count: 4,
            downloads_count: 12,
            source: { kind: "hosted" },
            latest_version: {
              id: "version-1",
              profile_id: "profile-1",
              version: "1.2.0",
              changelog: "",
              manifest_json: { skills: [{ name: "review" }] },
              created_at: "2026-08-10T00:00:00Z",
              published_at: "2026-08-10T00:00:00Z",
            },
          },
        ]);
      },
    });

    const profiles = await client.listPublicProfiles({
      query: " review & plan ",
      sort: "downloads",
    });

    expect(requestedUrl).toBe(
      "https://api.example.com/profiles?q=review+%26+plan&sort=downloads",
    );
    expect(profiles[0]).toMatchObject({
      slug: "review-stack",
      downloads_count: 12,
      latest_version: { version: "1.2.0" },
    });
  });

  it("reports upstream catalog failures with status context", async () => {
    const client = createRegistryClient({
      baseUrl: "https://api.example.com",
      fetch: async () => new Response("temporarily unavailable", { status: 503 }),
    });

    await expect(client.listPublicProfiles()).rejects.toThrow(
      "List profiles failed: HTTP 503 — temporarily unavailable",
    );
  });
});

describe("registry config", () => {
  let configPath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-registry-config-"));
    configPath = path.join(dir, "config.json");
  });

  it("round-trips keys and normalizes URLs", async () => {
    const service = createRegistryConfigService({ configPath });
    await service.set("apiBaseUrl", "https://api.example.com/");
    await service.set("apiToken", "  tok-123  ");
    expect(await service.get("apiBaseUrl")).toBe("https://api.example.com");
    expect(await service.get("apiToken")).toBe("tok-123");
    await service.unset("apiToken");
    expect(await service.get("apiToken")).toBeUndefined();
    await expect(service.set("apiBaseUrl", "not-a-url")).rejects.toThrow("Invalid registry URL");
  });

  it("resolves target and token with env taking precedence over config", async () => {
    const service = createRegistryConfigService({ configPath });
    await service.set("apiBaseUrl", "http://127.0.0.1:8080");
    await service.set("apiToken", "from-config");

    const fromConfig = await resolveRegistryApiTarget({ configPath, env: {} });
    expect(fromConfig).toEqual({
      apiBaseUrl: "http://127.0.0.1:8080",
      source: "config",
      mode: "local",
    });

    const fromEnv = await resolveRegistryApiTarget({
      configPath,
      env: { BRAINCTL_API_BASE_URL: "https://api.brainctl.net" },
    });
    expect(fromEnv).toEqual({
      apiBaseUrl: "https://api.brainctl.net",
      source: "env",
      mode: "prod",
    });

    expect(await resolveRegistryApiToken({ configPath, env: {} })).toEqual({
      token: "from-config",
      source: "config",
    });
    expect(
      await resolveRegistryApiToken({ configPath, env: { BRAINCTL_API_TOKEN: "from-env" } }),
    ).toEqual({ token: "from-env", source: "env" });
  });

  it("derives the frontend URL from the API host", async () => {
    expect(
      await resolveRegistryFrontendUrl({
        configPath,
        env: {},
        apiBaseUrl: "https://api.nomoreide.com",
      }),
    ).toBe("https://registry.nomoreide.com");
    expect(
      await resolveRegistryFrontendUrl({
        configPath,
        env: {},
        apiBaseUrl: "http://127.0.0.1:8080",
      }),
    ).toBe("http://127.0.0.1:5173");
  });

  // The pre-rename host is a known production target, not a custom one: it must
  // not fall through to the `api.` → `app.` guess, which would resolve to
  // `app.brainctl.net` — a host that has never existed.
  it("still maps the legacy brainctl API host to its own frontend", async () => {
    expect(
      await resolveRegistryFrontendUrl({
        configPath,
        env: {},
        apiBaseUrl: "https://api.brainctl.net",
      }),
    ).toBe("https://www.brainctl.net");
  });
});

describe("registry config brainctl back-compat", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "nomoreide-registry-home-"));
  });

  it("reads an existing brainctl sign-in when no nomoreide config exists", async () => {
    await mkdir(path.join(home, ".brainctl"), { recursive: true });
    await writeFile(
      path.join(home, ".brainctl", "config.json"),
      JSON.stringify({ apiToken: "legacy-token" }),
      "utf8",
    );

    expect(
      await resolveRegistryApiToken({ env: { NOMOREIDE_HOME: home } }),
    ).toEqual({ token: "legacy-token", source: "config" });
  });

  it("migrates the config to ~/.nomoreide on first write", async () => {
    await mkdir(path.join(home, ".brainctl"), { recursive: true });
    await writeFile(
      path.join(home, ".brainctl", "config.json"),
      JSON.stringify({ apiToken: "legacy-token" }),
      "utf8",
    );

    const service = createRegistryConfigService({ env: { NOMOREIDE_HOME: home } });
    await service.set("apiBaseUrl", "https://api.nomoreide.com");

    const migrated = JSON.parse(
      await readFile(path.join(home, ".nomoreide", "config.json"), "utf8"),
    );
    // The pre-existing token has to survive, or the write silently signs the user out.
    expect(migrated).toEqual({
      apiToken: "legacy-token",
      apiBaseUrl: "https://api.nomoreide.com",
    });
  });

  it("prefers the nomoreide config over a stale brainctl one", async () => {
    await mkdir(path.join(home, ".brainctl"), { recursive: true });
    await writeFile(
      path.join(home, ".brainctl", "config.json"),
      JSON.stringify({ apiToken: "stale" }),
      "utf8",
    );
    await mkdir(path.join(home, ".nomoreide"), { recursive: true });
    await writeFile(
      path.join(home, ".nomoreide", "config.json"),
      JSON.stringify({ apiToken: "current" }),
      "utf8",
    );

    expect(
      await resolveRegistryApiToken({ env: { NOMOREIDE_HOME: home } }),
    ).toEqual({ token: "current", source: "config" });
  });

  it("lets NOMOREIDE_* env win over the legacy BRAINCTL_* name", async () => {
    expect(
      await resolveRegistryApiToken({
        env: {
          NOMOREIDE_HOME: home,
          NOMOREIDE_API_TOKEN: "new",
          BRAINCTL_API_TOKEN: "old",
        },
      }),
    ).toEqual({ token: "new", source: "env" });

    expect(
      await resolveRegistryApiToken({
        env: { NOMOREIDE_HOME: home, BRAINCTL_API_TOKEN: "old" },
      }),
    ).toEqual({ token: "old", source: "env" });
  });
});

describe("registry token manager", () => {
  let configPath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-registry-auth-"));
    configPath = path.join(dir, "config.json");
  });

  it("refreshes once on 401, persists rotated tokens, and retries", async () => {
    const service = createRegistryConfigService({ configPath });
    await service.set("apiToken", "stale");
    await service.set("apiRefreshToken", "refresh-1");

    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ url, auth });
      if (url.endsWith("/auth/refresh")) {
        return Response.json({ access_token: "fresh", refresh_token: "refresh-2" });
      }
      if (auth === "Bearer fresh") return Response.json({ email: "me@example.com" });
      return new Response("unauthorized", { status: 401 });
    };

    const manager = createRegistryTokenManager({
      configService: service,
      configPath,
      env: {},
      apiBaseUrl: "https://api.example.com",
      fetch: fetchImpl,
    });

    const response = await manager.authenticatedFetch("/me");
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.com/me",
      "https://api.example.com/auth/refresh",
      "https://api.example.com/me",
    ]);
    expect(await service.get("apiToken")).toBe("fresh");
    expect(await service.get("apiRefreshToken")).toBe("refresh-2");
  });

  it("drops both tokens when the refresh itself is rejected", async () => {
    const service = createRegistryConfigService({ configPath });
    await service.set("apiToken", "stale");
    await service.set("apiRefreshToken", "dead");

    const fetchImpl: typeof fetch = async (input) =>
      new Response("nope", { status: 401, statusText: String(input) });

    const manager = createRegistryTokenManager({
      configService: service,
      configPath,
      env: {},
      apiBaseUrl: "https://api.example.com",
      fetch: fetchImpl,
    });

    const response = await manager.authenticatedFetch("/me");
    expect(response.status).toBe(401);
    expect(await service.get("apiToken")).toBeUndefined();
    expect(await service.get("apiRefreshToken")).toBeUndefined();
  });
});

describe("registry publish + install", () => {
  let homeDir: string;
  let cwd: string;
  const opts = () => ({ homeDir });

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-registry-home-"));
    cwd = await mkdtemp(path.join(os.tmpdir(), "nomoreide-registry-cwd-"));
  });

  async function makeLocalProfile(name: string): Promise<void> {
    await createProfile({ name }, opts());
    const skillDir = path.join(profileSkillsDir(name, opts()), "helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "# helper\n", "utf8");
    await updateProfile(
      name,
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
  }

  it("publishes create → version → upload → publish with a redacted gzip package", async () => {
    await makeLocalProfile("shareable");

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    let uploadedBytes: Uint8Array | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "GET" && url.endsWith("/profiles/dev-kit")) {
        return new Response("not found", { status: 404 });
      }
      if (method === "POST" && url.endsWith("/profiles")) {
        const body = JSON.parse(String(init?.body)) as { slug: string; title: string };
        expect(body).toMatchObject({ slug: "dev-kit", title: "Dev Kit", visibility: "public" });
        return Response.json({ id: "p1", slug: "dev-kit", title: "Dev Kit", summary: "" });
      }
      if (method === "POST" && url.endsWith("/profiles/p1/versions")) {
        const body = JSON.parse(String(init?.body)) as { manifest_json: Record<string, unknown> };
        expect(body.manifest_json).toMatchObject({
          name: "dev-kit",
          version: "2.0.0",
          mcps: [{ name: "github", kind: "local" }],
          skills: [{ name: "helper" }],
        });
        return Response.json({ id: "v1", profile_id: "p1", version: "2.0.0" });
      }
      if (method === "POST" && url.endsWith("/versions/v1/package")) {
        uploadedBytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        return Response.json({ ok: true });
      }
      if (method === "POST" && url.endsWith("/versions/v1/publish")) {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const result = await publishProfileToRegistry(
      {
        name: "shareable",
        slug: "dev-kit",
        title: "Dev Kit",
        version: "2.0.0",
        cwd,
        apiBaseUrl: "https://api.example.com",
        fetch: fetchImpl,
      },
      opts(),
    );

    expect(result).toEqual({ slug: "dev-kit", profileId: "p1", versionId: "v1", version: "2.0.0" });
    // gzip magic bytes — the upload is the export archive, not JSON
    expect(uploadedBytes![0]).toBe(0x1f);
    expect(uploadedBytes![1]).toBe(0x8b);
    // and the raw secret never appears in the uploaded package
    expect(Buffer.from(uploadedBytes!).includes(Buffer.from("ghp_super_secret"))).toBe(false);
    await expect(readProfileRegistryLink("shareable", opts())).resolves.toMatchObject({
      origin: "published",
      slug: "dev-kit",
      version: "2.0.0",
      profileId: "p1",
      versionId: "v1",
    });
  });

  it("installs a published package end-to-end via importProfile", async () => {
    await makeLocalProfile("origin");
    const archivePath = path.join(cwd, "origin.tar.gz");
    await exportProfile({ name: "origin", outputPath: archivePath, cwd }, opts());
    const archiveBytes = await readFile(archivePath);

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/profiles/dev-kit/install")) {
        return Response.json({
          slug: "dev-kit",
          version: "1.2.3",
          source_kind: "brainctl",
          download_url: "https://packages.example.com/dev-kit.tar.gz",
        });
      }
      if (url.endsWith("/dev-kit.tar.gz")) {
        return new Response(new Uint8Array(archiveBytes));
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await installProfileFromRegistry(
      {
        slug: "dev-kit",
        as: "installed",
        apiBaseUrl: "https://api.example.com",
        fetch: fetchImpl,
      },
      opts(),
    );

    expect(result).toMatchObject({
      name: "installed",
      mcpCount: 1,
      skillCount: 1,
      version: "1.2.3",
      sourceKind: "brainctl",
    });
    // secret was redacted at export and stays a placeholder after install
    expect(result.missingCredentials.map((spec) => spec.key)).toEqual(["github_token"]);
    const installed = await getProfile("installed", opts());
    expect(installed.mcps.github.env).toEqual({ GITHUB_TOKEN: "${credentials.github_token}" });
    await expect(readProfileRegistryLink("installed", opts())).resolves.toMatchObject({
      origin: "installed",
      slug: "dev-kit",
      version: "1.2.3",
    });

    // installing again without force refuses to clobber
    await expect(
      installProfileFromRegistry(
        { slug: "dev-kit", as: "installed", apiBaseUrl: "https://api.example.com", fetch: fetchImpl },
        opts(),
      ),
    ).rejects.toThrow("already exists");
  });

  it("resolves the relative download_url hosted profiles actually return", async () => {
    // The registry serves `/profiles/<slug>/download` — a path, not a URL, so
    // that one API can answer on both api.brainctl.net and api.nomoreide.com.
    // Passing it straight to fetch throws "Failed to parse URL".
    await makeLocalProfile("origin");
    const archivePath = path.join(cwd, "origin.tar.gz");
    await exportProfile({ name: "origin", outputPath: archivePath, cwd }, opts());
    const archiveBytes = await readFile(archivePath);

    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/profiles/dev-kit/install")) {
        return Response.json({
          slug: "dev-kit",
          version: "1.2.3",
          source_kind: "hosted",
          download_url: "/profiles/dev-kit/download",
        });
      }
      if (url === "https://api.example.com/profiles/dev-kit/download") {
        return new Response(new Uint8Array(archiveBytes));
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await installProfileFromRegistry(
      { slug: "dev-kit", as: "installed", apiBaseUrl: "https://api.example.com", fetch: fetchImpl },
      opts(),
    );

    expect(result).toMatchObject({ name: "installed", version: "1.2.3", sourceKind: "hosted" });
    expect(requested).toContain("https://api.example.com/profiles/dev-kit/download");
  });

  it("leaves an absolute download_url on another host untouched", async () => {
    // GitHub-sourced profiles point at a codeload archive, not at our API.
    await makeLocalProfile("origin");
    const archivePath = path.join(cwd, "origin.tar.gz");
    await exportProfile({ name: "origin", outputPath: archivePath, cwd }, opts());
    const archiveBytes = await readFile(archivePath);

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/profiles/dev-kit/install")) {
        return Response.json({
          slug: "dev-kit",
          version: "1.2.3",
          source_kind: "github",
          download_url: "https://codeload.github.com/o/r/tar.gz/main",
        });
      }
      if (url === "https://codeload.github.com/o/r/tar.gz/main") {
        return new Response(new Uint8Array(archiveBytes));
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await installProfileFromRegistry(
      // A trailing slash on the base must not produce a doubled slash.
      { slug: "dev-kit", as: "installed", apiBaseUrl: "https://api.example.com/", fetch: fetchImpl },
      opts(),
    );

    expect(result).toMatchObject({ name: "installed", sourceKind: "github" });
  });
});
