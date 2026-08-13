import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";

let tempDir: string;
let upstream: Server | undefined;
let web: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>> | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-registry-routes-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await web?.stop();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()) ?? resolve());
  await rm(tempDir, { recursive: true, force: true });
});

describe("agent registry catalog route", () => {
  test("validates queries and normalizes public profiles", async () => {
    let upstreamPath = "";
    upstream = createServer((request, response) => {
      upstreamPath = request.url ?? "";
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify([
          {
            id: "profile-1",
            slug: "review-stack",
            title: "Review Stack",
            summary: "Review tools",
            stars_count: 4,
            downloads_count: 12,
            author: {
              id: "author-1",
              display_name: "Ada Lovelace",
              avatar_url: "https://example.com/ada.png",
            },
            source: { kind: "github", github_repo_url: "https://github.com/acme/review" },
            latest_version: {
              id: "version-1",
              profile_id: "profile-1",
              version: "1.2.0",
              changelog: "",
              manifest_json: {
                mcps: [{ name: "github" }],
                skills: [{ name: "review" }, { name: "verify" }],
                plugins: "malformed",
              },
              created_at: "2026-08-09T00:00:00Z",
              published_at: "2026-08-10T00:00:00Z",
            },
          },
        ]),
      );
    });
    const upstreamUrl = await listen(upstream);
    vi.stubEnv("NOMOREIDE_API_BASE_URL", upstreamUrl);

    web = await createWebServer({
      configPath: join(tempDir, "config.json"),
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(
      `${web.url}/api/agent-env/registry/profiles?q=review%20%26%20plan&sort=downloads`,
    );
    expect(response.status).toBe(200);
    expect(upstreamPath).toBe("/profiles?q=review+%26+plan&sort=downloads");
    expect(await response.json()).toEqual({
      ok: true,
      profiles: [
        {
          id: "profile-1",
          slug: "review-stack",
          title: "Review Stack",
          summary: "Review tools",
          version: "1.2.0",
          sourceKind: "github",
          githubRepoUrl: "https://github.com/acme/review",
          starsCount: 4,
          downloadsCount: 12,
          author: {
            id: "author-1",
            displayName: "Ada Lovelace",
            avatarUrl: "https://example.com/ada.png",
          },
          publishedAt: "2026-08-10T00:00:00Z",
          mcpCount: 1,
          skillCount: 2,
          pluginCount: 0,
        },
      ],
    });

    const invalidSort = await fetch(
      `${web.url}/api/agent-env/registry/profiles?sort=unknown`,
    );
    expect(invalidSort.status).toBe(400);
    expect(await invalidSort.json()).toEqual({
      ok: false,
      error: "Invalid registry profile query.",
    });

    const longQuery = await fetch(
      `${web.url}/api/agent-env/registry/profiles?q=${"x".repeat(101)}`,
    );
    expect(longQuery.status).toBe(400);
  });
});

describe("agent registry install route", () => {
  test("reports an invalid published link as 422 with its archive member", async () => {
    const packageRoot = join(tempDir, "package");
    await writeFile(join(tempDir, "target.json"), "{}\n", "utf8");
    await symlink(join(tempDir, "target.json"), packageRoot);
    const archivePath = join(tempDir, "profile.tar.gz");
    await promisify(execFile)("tar", ["-czf", archivePath, "-C", tempDir, "package"]);
    const archive = await readFile(archivePath);

    upstream = createServer((request, response) => {
      if (request.url === "/profiles/broken/install") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          slug: "broken",
          version: "1.0.0",
          source_kind: "hosted",
          download_url: "/profiles/broken/download",
        }));
        return;
      }
      if (request.url === "/profiles/broken/download") {
        response.setHeader("content-type", "application/gzip");
        response.end(archive);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const upstreamUrl = await listen(upstream);
    vi.stubEnv("NOMOREIDE_API_BASE_URL", upstreamUrl);

    web = await createWebServer({
      configPath: join(tempDir, "config.json"),
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(
      `${web.url}/api/agent-env/profiles/install-from-registry`,
      {
        body: JSON.stringify({ slug: "broken" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Profile archive contains a link entry, which is not allowed: package",
    });
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}
