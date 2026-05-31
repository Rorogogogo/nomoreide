import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  cloneRepository,
  parseComposeServiceDetails,
  parseComposeServices,
  parseRepoUrl,
  proposeDatabases,
  proposeServices,
  scanRepo,
  type RepoProfile,
} from "../src/core/repo-onboard.js";

const execFileAsync = promisify(execFile);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-onboard-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function seed(files: Record<string, string>): Promise<string> {
  const repo = join(tempDir, "repo");
  await mkdir(repo, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(repo, name), content, "utf8");
  }
  return repo;
}

describe("parseRepoUrl", () => {
  test("parses https URLs with and without .git", () => {
    expect(parseRepoUrl("https://github.com/owner/My-Repo.git").name).toBe("my-repo");
    expect(parseRepoUrl("https://github.com/owner/My-Repo").name).toBe("my-repo");
  });

  test("parses scp-style ssh URLs", () => {
    const parsed = parseRepoUrl("git@github.com:owner/repo.git");
    expect(parsed.name).toBe("repo");
    expect(parsed.host).toBe("github.com");
    expect(parsed.owner).toBe("owner");
  });

  test("rejects empty and unrecognised input", () => {
    expect(() => parseRepoUrl("")).toThrow();
    expect(() => parseRepoUrl("not a url")).toThrow();
  });
});

describe("parseComposeServices", () => {
  test("extracts top-level service names", () => {
    const services = parseComposeServices(
      ["services:", "  web:", "    image: nginx", "  db:", "    image: postgres"].join("\n"),
    );
    expect(services).toEqual(["web", "db"]);
  });

  test("returns empty list for malformed yaml", () => {
    expect(parseComposeServices(":\n  - [")).toEqual([]);
  });
});

describe("parseComposeServiceDetails", () => {
  test("captures image, ports, and a map-form environment", () => {
    const details = parseComposeServiceDetails(
      [
        "services:",
        "  postgres:",
        "    image: pgvector/pgvector:pg16",
        "    ports:",
        '      - "5433:5432"',
        "    environment:",
        "      POSTGRES_DB: pawfectbite",
        "      POSTGRES_USER: pawfectbite",
        "      POSTGRES_PASSWORD: pawfectbite",
      ].join("\n"),
    );
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      name: "postgres",
      image: "pgvector/pgvector:pg16",
      ports: ["5433:5432"],
      environment: {
        POSTGRES_DB: "pawfectbite",
        POSTGRES_USER: "pawfectbite",
        POSTGRES_PASSWORD: "pawfectbite",
      },
    });
  });

  test("captures a KEY=value list-form environment", () => {
    const [service] = parseComposeServiceDetails(
      [
        "services:",
        "  db:",
        "    image: mysql:8",
        "    environment:",
        "      - MYSQL_DATABASE=shop",
        "      - MYSQL_USER=app",
      ].join("\n"),
    );
    expect(service.environment).toEqual({ MYSQL_DATABASE: "shop", MYSQL_USER: "app" });
  });
});

describe("proposeDatabases", () => {
  test("builds a Postgres connection on the published host port with env creds", () => {
    const profile: RepoProfile = {
      name: "pawfectbite",
      clonePath: "/tmp/pawfectbite",
      languages: ["docker"],
      envKeys: [],
      docker: {
        hasDockerfile: false,
        composeFile: "docker-compose.yml",
        composeServices: ["postgres"],
        services: [
          {
            name: "postgres",
            image: "pgvector/pgvector:pg16",
            ports: ["5433:5432"],
            environment: {
              POSTGRES_DB: "pawfectbite",
              POSTGRES_USER: "pawfectbite",
              POSTGRES_PASSWORD: "pawfectbite",
            },
          },
        ],
      },
    };
    const [db] = proposeDatabases(profile);
    expect(db).toMatchObject({
      name: "pawfectbite-db",
      engine: "postgres",
      url: "postgres://pawfectbite:pawfectbite@127.0.0.1:5433/pawfectbite",
      composeService: "postgres",
      confidence: "high",
    });
  });

  test("ignores non-database compose services", () => {
    const profile: RepoProfile = {
      name: "api",
      clonePath: "/tmp/api",
      languages: ["docker"],
      envKeys: [],
      docker: {
        hasDockerfile: false,
        composeFile: "docker-compose.yml",
        composeServices: ["api"],
        services: [{ name: "api", image: "node:20", ports: ["3000:3000"], environment: {} }],
      },
    };
    expect(proposeDatabases(profile)).toEqual([]);
  });
});

describe("scanRepo", () => {
  test("detects a Node repo with a dev script", async () => {
    const repo = await seed({
      "package.json": JSON.stringify({ scripts: { dev: "next dev -p 3000" } }),
      "package-lock.json": "{}",
      ".env.example": "PORT=\nAPI_KEY=secret-should-be-dropped",
      "README.md": "# App\n## Getting Started\nRun `npm run dev`.",
    });
    const profile = await scanRepo(repo);
    expect(profile.node?.packageManager).toBe("npm");
    expect(profile.node?.hasDevScript).toBe(true);
    expect(profile.envKeys).toEqual(["PORT", "API_KEY"]);
    expect(profile.readmeExcerpt).toContain("Getting Started");
    expect(profile.languages).toContain("node");
  });

  test("detects pnpm and a Python framework", async () => {
    const repo = await seed({
      "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
      "pnpm-lock.yaml": "lockfileVersion: 6.0",
      "requirements.txt": "fastapi\nuvicorn",
    });
    const profile = await scanRepo(repo);
    expect(profile.node?.packageManager).toBe("pnpm");
    expect(profile.python?.framework).toBe("fastapi");
  });

  test("detects docker-compose services", async () => {
    const repo = await seed({
      "docker-compose.yml": ["services:", "  api:", "    build: .", "  cache:", "    image: redis"].join("\n"),
    });
    const profile = await scanRepo(repo);
    expect(profile.docker?.composeFile).toBe("docker-compose.yml");
    expect(profile.docker?.composeServices).toEqual(["api", "cache"]);
  });
});

describe("proposeServices", () => {
  test("ranks a Node dev script as a high-confidence local proposal", async () => {
    const repo = await seed({
      "package.json": JSON.stringify({ scripts: { dev: "vite --port 5173" } }),
    });
    const proposals = proposeServices(await scanRepo(repo));
    expect(proposals[0]).toMatchObject({
      kind: "local",
      command: "npm run dev",
      port: 5173,
      installCommand: "npm install",
      confidence: "high",
    });
  });

  test("proposes a docker-compose service per compose entry, primary first", () => {
    const profile: RepoProfile = {
      name: "api",
      clonePath: "/tmp/api",
      languages: ["docker"],
      envKeys: [],
      docker: {
        hasDockerfile: false,
        composeFile: "docker-compose.yml",
        composeServices: ["db", "api"],
      },
    };
    const proposals = proposeServices(profile);
    expect(proposals[0]).toMatchObject({
      kind: "docker-compose",
      name: "api",
      composeService: "api",
      confidence: "high",
    });
  });

  test("uses the published host port for a docker-compose proposal", () => {
    const profile: RepoProfile = {
      name: "shop",
      clonePath: "/tmp/shop",
      languages: ["docker"],
      envKeys: [],
      docker: {
        hasDockerfile: false,
        composeFile: "docker-compose.yml",
        composeServices: ["web"],
        services: [{ name: "web", image: "nginx", ports: ["8080:80"], environment: {} }],
      },
    };
    expect(proposeServices(profile)[0]).toMatchObject({
      kind: "docker-compose",
      composeService: "web",
      port: 8080,
    });
  });
});

describe("cloneRepository", () => {
  test("clones a local repo via file:// and refuses a non-empty dest", async () => {
    // Build a real source repo to clone from (no network).
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    const git = (args: string[]) => execFileAsync("git", ["-C", source, ...args]);
    await git(["init", "-q"]);
    await git(["config", "user.email", "t@t.dev"]);
    await git(["config", "user.name", "t"]);
    await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { dev: "x" } }));
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "init"]);

    const destRoot = join(tempDir, "repos");
    const result = await cloneRepository(`file://${source}`, destRoot);
    expect(result.name).toBe("source");
    expect(result.clonePath).toBe(join(destRoot, "source"));

    // Second clone into the now-populated dest must fail.
    await expect(cloneRepository(`file://${source}`, destRoot)).rejects.toThrow(/not empty/);
  });
});
