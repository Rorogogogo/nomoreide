/**
 * Phase 6 parity gate for the hosted profile registry:
 *
 *   GET  /api/agent-env/registry/profiles
 *   POST /api/agent-env/profiles/install-from-registry
 *   POST /api/agent-env/profiles/register-github
 *   POST /api/agent-env/profiles/:name/publish
 *
 * **The registry is a stub this gate runs**, pointed at through
 * `NOMOREIDE_API_BASE_URL`. It is deliberately *stateless*: both runtimes call
 * the same server, so a stub that remembered a publish would answer the second
 * runtime differently from the first and the diff would report a divergence
 * that is really just ordering. Every answer here is a function of the request.
 *
 * Three things are gated closely because they are easy to port wrongly:
 *
 * - **The listing renames every field.** `display_name` → `displayName`,
 *   `latest_version.version` → `version`, and a null author or avatar is
 *   *dropped* rather than sent as null. A port that passed the registry's own
 *   JSON through would look right until the dashboard read `profile.version`.
 * - **The status codes are derived from the error text.** An upstream "HTTP
 *   4xx" is surfaced as itself and everything else becomes 502; an install
 *   failure adds 409 for "already exists" and 422 for a bad archive. That is a
 *   substring match on a message, not a typed error, and it is the contract.
 * - **Publishing walks five calls.** Lookup, create-if-new, create version,
 *   upload, release. The gate publishes both a new slug and one the stub
 *   already knows, so the skipped-create branch is covered too.
 *
 * Usage:
 *   node --import tsx scripts/check-agent-registry-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-agent-registry-parity.ts [--dump] <candidate> [args...]",
  );
}

const PROFILES = "/api/agent-env/profiles";
const ROOT = ".config/nomoreide/agent-profiles";
/** The one token the stub accepts. */
const TOKEN = "token-that-works";

/** The archive every install downloads — one runtime's export, served to both. */
let archive: Buffer = Buffer.alloc(0);

/**
 * A registry that answers from the request alone.
 *
 * `q=boom` and `q=gone` are how the gate reaches the two upstream-failure
 * branches without taking the server down mid-run.
 */
function startRegistry(): Promise<{ server: Server; base: string }> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://registry.invalid");
    const path = url.pathname;
    const signedIn = request.headers.authorization === `Bearer ${TOKEN}`;
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (path === "/me") {
      return signedIn
        ? json(200, { email: "someone@example.com", display_name: "Someone", avatar_url: null })
        : json(401, { error: "unauthorized" });
    }

    if (path === "/download/good") {
      response.writeHead(200, { "content-type": "application/gzip" });
      return response.end(archive);
    }
    if (path === "/download/junk") {
      response.writeHead(200, { "content-type": "application/gzip" });
      return response.end("not a tarball");
    }
    if (path === "/download/missing") {
      response.writeHead(404, { "content-type": "text/plain" });
      return response.end("no such package");
    }

    if (path === "/profiles" && request.method === "GET") {
      const q = url.searchParams.get("q");
      if (q === "boom") {
        response.writeHead(500, { "content-type": "text/plain" });
        return response.end("upstream is down");
      }
      if (q === "gone") {
        response.writeHead(404, { "content-type": "text/plain" });
        return response.end("no such listing");
      }
      // The query is echoed into the summary, which is how the gate sees that
      // `q` and `sort` were forwarded at all rather than quietly dropped.
      return json(200, [
        {
          id: "p-full",
          slug: "full",
          title: "Everything filled in",
          summary: `q=${q ?? ""} sort=${url.searchParams.get("sort") ?? ""}`,
          source: { kind: "upload", github_repo_url: "https://github.com/example/profile" },
          stars_count: 12,
          downloads_count: 340,
          author: { id: "u-1", display_name: "Someone", avatar_url: "https://img.test/a.png" },
          latest_version: {
            version: "2.3.4",
            published_at: "2026-01-02T03:04:05.000Z",
            manifest_json: { mcps: [{ name: "a" }, { name: "b" }], skills: [{ name: "s" }], plugins: [] },
          },
        },
        {
          // Every optional field null, which is the shape that decides whether
          // a port sends `null` or omits the key.
          id: "p-bare",
          slug: "bare",
          title: "Nothing filled in",
          summary: null,
          source: { kind: "github", github_repo_url: null },
          stars_count: 0,
          downloads_count: 0,
          author: null,
          latest_version: { version: "0.1.0", published_at: null, manifest_json: {} },
        },
      ]);
    }

    if (path === "/profiles" && request.method === "POST") {
      const body = JSON.parse(await readBody(request));
      return json(200, {
        id: `p-${body.slug}`,
        slug: body.slug,
        title: body.title,
        summary: body.summary,
        visibility: body.visibility,
      });
    }

    if (path === "/profiles/github/register") {
      if (!signedIn) return json(401, { error: "unauthorized" });
      const body = JSON.parse(await readBody(request));
      return json(200, { id: `p-${body.slug}`, slug: body.slug, ref_name: body.ref_name });
    }

    const install = /^\/profiles\/([^/]+)\/install$/.exec(path);
    if (install) {
      const answers: Record<string, unknown> = {
        installable: { version: "2.3.4", source_kind: "upload", download_url: "/download/good" },
        "no-package": { version: "1.0.0", source_kind: "upload", download_url: null },
        "bad-bytes": { version: "1.0.0", source_kind: "upload", download_url: "/download/junk" },
        "dead-link": { version: "1.0.0", source_kind: "upload", download_url: "/download/missing" },
      };
      const answer = answers[install[1]];
      return answer ? json(200, answer) : json(404, { error: "no such profile" });
    }

    const version = /^\/profiles\/([^/]+)\/versions$/.exec(path);
    if (version) {
      if (!signedIn) return json(401, { error: "unauthorized" });
      const body = JSON.parse(await readBody(request));
      return json(200, { id: `v-${install ? "x" : version[1]}`, version: body.version });
    }
    if (/^\/profiles\/[^/]+\/versions\/[^/]+\/(package|publish)$/.test(path)) {
      return signedIn ? json(200, { ok: true }) : json(401, { error: "unauthorized" });
    }

    const bySlug = /^\/profiles\/([^/]+)$/.exec(path);
    if (bySlug && request.method === "GET") {
      // Exactly one slug is already registered, so the publish chain's
      // create-if-new branch and its skip-create branch are both reachable.
      return bySlug[1] === "known-one"
        ? json(200, { id: "p-known-one", slug: "known-one", title: "Already there" })
        : json(404, { error: "no such profile" });
    }

    return json(404, { error: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8") || "{}"));
  });
}

interface HomeFile {
  readonly path: string;
  readonly contents: string;
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: string;
  /** Runs against this runtime before the request. */
  readonly mutate?: (runtime: Runtime) => Promise<void>;
}

const profile = (fields: Record<string, unknown>) =>
  JSON.stringify({ mcps: {}, skills: [], plugins: [], ...fields }, null, 2);

const FIXTURE: readonly HomeFile[] = [
  {
    path: `${ROOT}/base/profile.json`,
    contents: profile({
      name: "base",
      description: "The one that gets published.",
      sourceAgent: "claude",
      mcps: { linear: { kind: "remote", transport: "http", url: "https://mcp.linear.app/mcp" } },
      skills: [{ name: "summarise" }],
    }),
  },
  {
    path: `${ROOT}/base/skills/summarise/SKILL.md`,
    contents: "---\nname: summarise\ndescription: S.\n---\n\nS.\n",
  },
];

/** Writing this file is what "signing in" means to every route here. */
async function signIn(runtime: Runtime): Promise<void> {
  const path = join(runtime.home, ".nomoreide", "config.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ apiToken: TOKEN }, null, 2)}\n`, "utf8");
}

async function signOut(runtime: Runtime): Promise<void> {
  await rm(join(runtime.home, ".nomoreide", "config.json"), { force: true });
}

const steps: Step[] = [
  /* ---- browsing the registry ---- */
  { name: "registry/an-empty-search", method: "GET", path: "/api/agent-env/registry/profiles" },
  { name: "registry/a-query-and-a-sort", method: "GET", path: "/api/agent-env/registry/profiles?q=agents&sort=stars" },
  { name: "registry/a-query-that-is-only-spaces", method: "GET", path: "/api/agent-env/registry/profiles?q=%20%20" },
  { name: "registry/a-sort-that-is-not-one", method: "GET", path: "/api/agent-env/registry/profiles?sort=nope" },
  { name: "registry/a-query-past-the-limit", method: "GET", path: `/api/agent-env/registry/profiles?q=${"x".repeat(101)}` },
  { name: "registry/a-query-at-the-limit", method: "GET", path: `/api/agent-env/registry/profiles?q=${"x".repeat(100)}` },
  { name: "registry/the-registry-refused", method: "GET", path: "/api/agent-env/registry/profiles?q=boom" },
  { name: "registry/the-registry-said-404", method: "GET", path: "/api/agent-env/registry/profiles?q=gone" },
  { name: "registry/wrong-method", method: "POST", path: "/api/agent-env/registry/profiles", body: "{}" },

  /* ---- installing, while signed out: reads need no token ---- */
  { name: "install/no-slug", method: "POST", path: `${PROFILES}/install-from-registry`, body: "{}" },
  { name: "install/a-slug-that-is-blank", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":""}' },
  { name: "install/a-slug-that-is-a-number", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":7}' },
  { name: "install/one-the-registry-does-not-have", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"nope"}' },
  { name: "install/it-works", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"installable"}' },
  { name: "install/the-same-one-again", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"installable"}' },
  { name: "install/again-with-force", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"installable","force":true}' },
  { name: "install/under-another-name", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"installable","as":"copied"}' },
  { name: "install/a-version-with-no-package", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"no-package"}' },
  { name: "install/bytes-that-are-not-an-archive", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"bad-bytes"}' },
  { name: "install/a-download-that-is-gone", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"dead-link"}' },
  // The escape `as: ".."` is refused by the importer, not by this route — the
  // check belongs to import and has to survive being reached through here too.
  { name: "install/under-a-name-that-escapes", method: "POST", path: `${PROFILES}/install-from-registry`, body: '{"slug":"installable","as":"..","force":true}' },
  { name: "install/the-listing-afterwards", method: "GET", path: PROFILES },

  /* ---- writes, refused while signed out ---- */
  { name: "register-github/signed-out", method: "POST", path: `${PROFILES}/register-github`, body: '{"repoUrl":"https://github.com/example/p","slug":"from-gh","title":"From GitHub"}' },
  { name: "publish/signed-out", method: "POST", path: `${PROFILES}/base/publish`, body: '{"slug":"base","title":"Base"}' },
  // A body that fails validation is refused before the token is looked at, so
  // these two answer 400 rather than 401 even signed out.
  { name: "register-github/no-body-signed-out", method: "POST", path: `${PROFILES}/register-github`, body: "{}" },
  { name: "publish/no-body-signed-out", method: "POST", path: `${PROFILES}/base/publish`, body: "{}" },

  /* ---- signed in ---- */
  { name: "register-github/no-body", method: "POST", path: `${PROFILES}/register-github`, body: "{}", mutate: signIn },
  { name: "register-github/a-repo-url-that-is-blank", method: "POST", path: `${PROFILES}/register-github`, body: '{"repoUrl":"","slug":"s","title":"T"}' },
  { name: "register-github/the-required-three", method: "POST", path: `${PROFILES}/register-github`, body: '{"repoUrl":"https://github.com/example/p","slug":"from-gh","title":"From GitHub"}' },
  { name: "register-github/every-field", method: "POST", path: `${PROFILES}/register-github`, body: '{"repoUrl":"https://github.com/example/p","slug":"from-gh","title":"From GitHub","summary":"S","refName":"trunk","profilePath":"nested/profile.yaml"}' },

  { name: "publish/no-body", method: "POST", path: `${PROFILES}/base/publish`, body: "{}" },
  { name: "publish/a-title-that-is-blank", method: "POST", path: `${PROFILES}/base/publish`, body: '{"slug":"base","title":""}' },
  { name: "publish/a-profile-that-is-not-here", method: "POST", path: `${PROFILES}/nothing-here/publish`, body: '{"slug":"nothing","title":"Nothing"}' },
  { name: "publish/a-slug-the-registry-is-new-to", method: "POST", path: `${PROFILES}/base/publish`, body: '{"slug":"brand-new","title":"Brand new","summary":"S","version":"1.2.3","changelog":"first","visibility":"private"}' },
  { name: "publish/a-slug-the-registry-knows", method: "POST", path: `${PROFILES}/base/publish`, body: '{"slug":"known-one","title":"Already there"}' },
  { name: "publish/wrong-method", method: "GET", path: `${PROFILES}/base/publish` },
  { name: "publish/the-listing-afterwards", method: "GET", path: PROFILES },

  /* ---- and signed out again ---- */
  { name: "register-github/after-signing-out", method: "POST", path: `${PROFILES}/register-github`, body: '{"repoUrl":"https://github.com/example/p","slug":"from-gh","title":"From GitHub"}', mutate: signOut },
];

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const credentials = new Map<string, string>();

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  if (step.mutate) await step.mutate(runtime);
  const credential = credentials.get(runtime.label) ?? "";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      "content-type": "application/json",
    },
    body: step.body,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* the SPA shell is HTML, compared as the text it was */
  }
  return { status: response.status, body };
}

/** `YYYYMMDD-HHMMSS`, and the counter a collision appends. */
const STAMP = /\b\d{8}-\d{6}(?:-\d+)?\b/g;

function normalize(value: unknown, runtime: Runtime, registryBase: string): unknown {
  const text = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .split(registryBase)
    .join("<registry>")
    .split(`127.0.0.1:${runtime.port}`)
    .join("<daemon>")
    // Both an install and a publish stage the archive under a fresh mkdtemp,
    // and the reported path carries it.
    .replace(/"\/private\/var\/folders\/[^"]*"/g, '"<tmp>"')
    .replace(/"\/var\/folders\/[^"]*"/g, '"<tmp>"')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>")
    .replace(STAMP, "<stamp>");
  return JSON.parse(text);
}

const root = await mkdtemp(join(tmpdir(), "nmi-agent-registry-parity-"));
const harness = new RuntimeHarness(root);
const { server, base: registryBase } = await startRegistry();
let failures = 0;

function compare(name: string, reference: unknown, candidate: unknown): void {
  if (dump) {
    console.log(`--- ${name} ---`);
    console.log(`  reference: ${inspect(reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(candidate, { depth: null })}`);
  }
  try {
    assert.deepStrictEqual(candidate, reference);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`  reference: ${inspect(reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(candidate, { depth: null })}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
      () => [],
    );
    // The fixture lives in the runtime's *home* — `provision` writes into the
    // workspace, and a profile is not a workspace file.
    for (const file of FIXTURE) {
      const target = join(runtime.home, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, "utf8");
    }
    await harness.startDaemon(
      runtime,
      {
        NOMOREIDE_API_BASE_URL: registryBase,
        NOMOREIDE_FRONTEND_URL: `${registryBase}/app`,
        // Cleared so a developer's own signed-in shell cannot leak in.
        NOMOREIDE_API_TOKEN: "",
        BRAINCTL_API_TOKEN: "",
      },
      runtime.workspace,
    );
    credentials.set(
      runtime.label,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  // One runtime exports the archive both installs download, so the bytes are
  // identical on both sides and an install can only differ in what it does
  // with them.
  //
  // It lands inside the reference's *own* home rather than the shared harness
  // root: a recording rewrites a runtime's home and workspace to tokens and
  // puts the replaying run's paths back, and a path belonging to neither would
  // be replayed as the directory the recording was made in — which is gone.
  await signIn(reference);
  const exported = (await send(reference, {
    name: "setup/export",
    method: "POST",
    path: `${PROFILES}/base/export`,
    body: JSON.stringify({ outputPath: join(reference.home, "seed.tar.gz") }),
  })) as { body: { archivePath?: string } };
  if (typeof exported.body.archivePath !== "string") {
    throw new Error(`the seed export did not write an archive: ${inspect(exported)}`);
  }
  archive = await readFile(exported.body.archivePath);
  await signOut(reference);

  for (const step of steps) {
    compare(
      step.name,
      normalize(await send(reference, step), reference, registryBase),
      normalize(await send(candidate, step), candidate, registryBase),
    );
  }
} finally {
  server.close();
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.log(`\nagent-registry parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log("\nagent-registry parity: all cases match");
