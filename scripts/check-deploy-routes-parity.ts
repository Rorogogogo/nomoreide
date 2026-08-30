/**
 * Parity gate for the deploy provider's read routes:
 *
 *   GET /api/providers/:provider/projects
 *   GET /api/providers/:provider/deployments
 *
 * These are the first two provider routes the dashboard calls and the daemon
 * did not serve. `status`, `env`, `domains`, `scope`, the OAuth pair and
 * `project` are still the reference's; see the Phase 8 section of
 * `docs/plans/2026-08-20-native-rust-runtime-and-mcp.md` for why `status` is
 * not simply next.
 *
 * The vendor stub is `test/fixtures/mcp-deploy-parity-v1.json`'s, so there is
 * one description of what Vercel and Cloudflare answer rather than two that can
 * drift. Two routes it does not carry are added here, because the MCP tools
 * that fixture was written for never read a project by id *and* then list its
 * deployments in the same breath — the pinned project is read through
 * `/v9/projects/:id`, and the tools pin a different one.
 *
 * What the cases are watching for:
 *
 * **A repository with no project is not an error.** `deployments` answers 200
 * with an empty list and an explicit `project: null`. A port that refused
 * would render the panel as broken where the reference renders a chooser.
 *
 * **`limit` is `parseInt`, not `Number`.** `20abc` is twenty and `abc` is
 * nothing; a value at or below zero is dropped rather than clamped, so the
 * vendor's own default of twenty applies instead of a limit of one. The
 * recorded requests are compared, not just the payloads, so a candidate that
 * reaches the vendor with a different `limit` diverges even when the stub
 * happens to answer both the same.
 *
 * **`search` is trimmed and then emptied.** `?search=%20%20` is no filter at
 * all, not a filter that matches nothing.
 *
 * **An unknown target is no target.** Only `production` and `preview` survive.
 *
 * Usage:
 *   node --import tsx scripts/check-deploy-routes-parity.ts [--dump] <candidate> [args...]
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";
import { type ApiStub, type StubRoute, startApiStub } from "./support/http-api-stub.js";

const argv = process.argv.slice(2).filter((value) => value !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-deploy-routes-parity.ts [--dump] <candidate> [args...]",
  );
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-deploy-parity-v1.json"), "utf8"),
) as { fixtureVersion: number; api: StubRoute[] };
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported deploy parity fixture version ${fixture.fixtureVersion}`);
}

/** The project the pinned repository resolves to, read by id. */
const PINNED_PROJECT = {
  id: "prj_app",
  name: "app",
  framework: "nextjs",
  updatedAt: 1700000001000,
  link: { type: "github", org: "acme", repo: "app", repoId: 42, productionBranch: "main" },
  buildCommand: "npm run build",
  devCommand: null,
  installCommand: null,
  outputDirectory: ".next",
  rootDirectory: "apps/web",
  nodeVersion: "20.x",
  targets: { production: { id: "dpl_ready" } },
};

/**
 * The two reads the shared fixture has no reason to carry, plus the two
 * `limit` spellings these cases produce.
 */
const EXTRA: StubRoute[] = [
  { method: "GET", path: "/v9/projects/prj_app?teamId=team_acme", body: PINNED_PROJECT },
  {
    method: "GET",
    path: "/v7/deployments?projectId=prj_app&limit=5&teamId=team_acme",
    body: { deployments: [] },
  },
  {
    method: "GET",
    path: "/v7/deployments?projectId=prj_app&limit=100&teamId=team_acme",
    body: { deployments: [] },
  },
];

const api = [...fixture.api, ...EXTRA];

/** A connected provider whose project list and deployment list both refuse. */
const FAILURE_API: StubRoute[] = [
  { method: "GET", path: "/v9/projects/prj_app?teamId=team_acme", body: PINNED_PROJECT },
  {
    method: "GET",
    path: "/v10/projects?limit=50&teamId=team_acme",
    status: 503,
    body: { error: { message: "Projects unavailable." } },
  },
  {
    method: "GET",
    path: "/v7/deployments?projectId=prj_app&limit=20&teamId=team_acme",
    status: 429,
    body: { error: { message: "Deployment quota exceeded." } },
  },
];

interface Step {
  name: string;
  path: string;
  method?: string;
  /** Cloudflare reads its canonical deployment alongside the listing. */
  concurrentRequests?: boolean;
}

const VERCEL_STEPS: Step[] = [
  { name: "projects/all", path: "/api/providers/vercel/projects" },
  { name: "projects/a-search", path: "/api/providers/vercel/projects?search=doc" },
  { name: "projects/a-search-of-spaces", path: "/api/providers/vercel/projects?search=%20%20" },
  { name: "projects/a-search-with-punctuation", path: "/api/providers/vercel/projects?search=a%20b%21" },
  { name: "projects/a-post-is-still-a-read", path: "/api/providers/vercel/projects", method: "POST" },
  { name: "deployments/default-limit", path: "/api/providers/vercel/deployments" },
  { name: "deployments/production", path: "/api/providers/vercel/deployments?target=production" },
  { name: "deployments/an-unknown-target", path: "/api/providers/vercel/deployments?target=staging" },
  { name: "deployments/a-limit", path: "/api/providers/vercel/deployments?limit=5" },
  { name: "deployments/a-limit-over-the-cap", path: "/api/providers/vercel/deployments?limit=500" },
  {
    name: "deployments/a-limit-over-u32",
    path: "/api/providers/vercel/deployments?limit=4294967297",
  },
  { name: "deployments/a-limit-with-trailing-text", path: "/api/providers/vercel/deployments?limit=5abc" },
  { name: "deployments/a-limit-that-is-not-a-number", path: "/api/providers/vercel/deployments?limit=abc" },
  { name: "deployments/a-limit-of-zero", path: "/api/providers/vercel/deployments?limit=0" },
  { name: "deployments/a-negative-limit", path: "/api/providers/vercel/deployments?limit=-3" },
  {
    name: "deployments/a-delete-is-still-a-read",
    path: "/api/providers/vercel/deployments?limit=5",
    method: "DELETE",
  },
  { name: "projects/an-unknown-provider", path: "/api/providers/nowhere/projects" },
  { name: "deployments/an-unknown-provider", path: "/api/providers/nowhere/deployments" },
];

/** The same walk again with nothing pinned, so the no-project branch is real. */
const VERCEL_UNPINNED_STEPS: Step[] = [
  { name: "unpinned/deployments", path: "/api/providers/vercel/deployments" },
  { name: "unpinned/projects", path: "/api/providers/vercel/projects" },
];

/** Provider-neutral routing must exercise the second implementation too. */
const CLOUDFLARE_STEPS: Step[] = [
  { name: "cloudflare/projects/all", path: "/api/providers/cloudflare/projects" },
  {
    name: "cloudflare/projects/a-case-insensitive-search",
    path: "/api/providers/cloudflare/projects?search=DOC",
  },
  {
    name: "cloudflare/projects/a-search-of-spaces",
    path: "/api/providers/cloudflare/projects?search=%20%20",
  },
  {
    name: "cloudflare/deployments/default-limit",
    path: "/api/providers/cloudflare/deployments",
    concurrentRequests: true,
  },
  {
    name: "cloudflare/deployments/production",
    path: "/api/providers/cloudflare/deployments?target=production",
    concurrentRequests: true,
  },
  {
    name: "cloudflare/deployments/preview",
    path: "/api/providers/cloudflare/deployments?target=preview",
    concurrentRequests: true,
  },
  {
    name: "cloudflare/deployments/a-limit",
    path: "/api/providers/cloudflare/deployments?limit=5",
    concurrentRequests: true,
  },
  {
    name: "cloudflare/deployments/a-limit-over-the-cap",
    path: "/api/providers/cloudflare/deployments?limit=500",
    concurrentRequests: true,
  },
];

const FAILURE_STEPS: Step[] = [
  { name: "failures/projects/vendor-refusal", path: "/api/providers/vercel/projects" },
  { name: "failures/deployments/vendor-refusal", path: "/api/providers/vercel/deployments" },
];

const DISCONNECTED_STEPS: Step[] = [
  { name: "disconnected/projects", path: "/api/providers/vercel/projects" },
  { name: "disconnected/deployments", path: "/api/providers/vercel/deployments" },
];

const root = join(process.env.TMPDIR ?? "/tmp", `nomoreide-deploy-routes-${process.pid}`);
await mkdir(root, { recursive: true });
const harness = new RuntimeHarness(root);
const credentials = new Map<Runtime, string>();
const stubs: ApiStub[] = [];
let failures = 0;

async function send(runtime: Runtime, step: Step): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method ?? "GET",
    headers: { Authorization: `Bearer ${credentials.get(runtime) ?? ""}` },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* a non-JSON answer is compared as the text it was */
  }
  return { status: response.status, body };
}

interface WalkOptions {
  label: string;
  provider: "vercel" | "cloudflare";
  pinned: boolean;
  plan: Step[];
  api?: StubRoute[];
  connected?: boolean;
}

async function walk({
  label,
  provider,
  pinned,
  plan,
  api: stubRoutes = api,
  connected = true,
}: WalkOptions): Promise<void> {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      { ...spec, label: `${spec.label}-${label}` },
      (rt) => ({
        version: 1,
        connections: connected
          ? {
              [provider]: {
                source: "stored",
                token: `${provider}-parity-token`,
                ...(provider === "vercel" ? { scopeId: "team_acme" } : { scopeId: "acc_acme" }),
              },
            }
          : {},
        gitRepositories: [
          {
            name: "app",
            path: join(rt.workspace, "app"),
            ...(pinned
              ? { providerProjects: { [provider]: provider === "vercel" ? "prj_app" : "app" } }
              : {}),
          },
        ],
        selectedGitRepository: "app",
        services: [],
        bundles: [],
        databases: [],
        sshServers: [],
      }),
      () => [{ path: "app/.keep", contents: "" }],
    );
    const stub = await startApiStub(stubRoutes);
    stubs.push(stub);
    await harness.startDaemon(runtime, {
      ...(provider === "vercel"
        ? { NOMOREIDE_VERCEL_API_BASE: stub.base }
        : { NOMOREIDE_CLOUDFLARE_API_BASE: stub.base }),
    });
    credentials.set(
      runtime,
      (await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => "")) as string,
    );
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;
  const [referenceStub, candidateStub] = stubs.slice(-2);
  // Whatever each side did while resolving the project: compared per step
  // below, not here.
  referenceStub.take();
  candidateStub.take();

  for (const step of plan) {
    const requests = (stub: ApiStub) => {
      const observed = stub.take();
      return step.concurrentRequests
        ? observed.toSorted((left, right) =>
            `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
          )
        : observed;
    };
    const answers = {
      reference: { answer: await send(reference, step), requests: requests(referenceStub) },
      candidate: { answer: await send(candidate, step), requests: requests(candidateStub) },
    };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
    try {
      assert.deepStrictEqual(answers.candidate, answers.reference);
      console.log(`ok   ${step.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${step.name}`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

try {
  await walk({ label: "vercel-pinned", provider: "vercel", pinned: true, plan: VERCEL_STEPS });
  await walk({
    label: "vercel-unpinned",
    provider: "vercel",
    pinned: false,
    plan: VERCEL_UNPINNED_STEPS,
  });
  await walk({
    label: "cloudflare-pinned",
    provider: "cloudflare",
    pinned: true,
    plan: CLOUDFLARE_STEPS,
  });
  await walk({
    label: "vercel-failures",
    provider: "vercel",
    pinned: true,
    plan: FAILURE_STEPS,
    api: FAILURE_API,
  });
  await walk({
    label: "vercel-disconnected",
    provider: "vercel",
    pinned: true,
    plan: DISCONNECTED_STEPS,
    connected: false,
  });
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await rm(root, { recursive: true, force: true });
}

const total =
  VERCEL_STEPS.length +
  VERCEL_UNPINNED_STEPS.length +
  CLOUDFLARE_STEPS.length +
  FAILURE_STEPS.length +
  DISCONNECTED_STEPS.length;
if (failures > 0) {
  console.log(`\ndeploy-routes parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndeploy-routes parity: ${total} cases match`);
