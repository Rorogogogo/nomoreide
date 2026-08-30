/**
 * Parity gate for the deploy provider's per-deployment surface:
 *
 *   GET    /api/providers/:provider/deployments/:deployment
 *   GET    /api/providers/:provider/deployments/:deployment/logs
 *   GET    /api/providers/:provider/deployments/:deployment/runtime-logs
 *   POST   /api/providers/:provider/deployments/:deployment/:action
 *
 * Its own gate rather than more cases in `check-deploy-routes-parity.ts`,
 * because the last of those four is the **write boundary** — the one door every
 * deploy-changing operation goes through — and a gate that only diffed answers
 * would say nothing about what was changed. So the recorded vendor requests are
 * compared for every case, bodies included: a port that promoted the right
 * deployment by `POST`ing the wrong path would still agree on `{ ok: true }`.
 *
 * What the cases are watching for:
 *
 * **Which names are legal comes from the manifest.** `cancel` and `promote` are
 * Vercel's words; Pages has retry and rollback and no promote at all. An action
 * a provider does not declare is a 404 *before* any credential is resolved, and
 * the action name is never percent-decoded — so `red%65ploy` is an unknown
 * action rather than a redeploy.
 *
 * **The original deployment is read first, and a failure to read it is
 * swallowed.** Vercel's redeploy needs the original's name and target — without
 * the target a production retry silently comes back as a preview — so the
 * recorded `POST` body is what proves the target travelled. But `cancel` needs
 * neither, so a deployment that will not read must still cancel.
 *
 * **A missing project is a different failure per provider.** Vercel's ids are
 * global, so an unlinked repository can still redeploy and cancel and only
 * `promote`/`rollback` refuse; Cloudflare addresses a deployment *within* its
 * project, so everything refuses, and its own read refuses one layer earlier
 * with a different sentence.
 *
 * **A provider without runtime logs answers an empty list, not an error**, and
 * makes no request at all — the recorded requests are the only thing that shows
 * the second half. So does a Vercel account whose plan is not entitled to them,
 * where the vendor's 403 is swallowed and a 500 would be wrong.
 *
 * **Presence is contract in a log line.** A runtime line carries its request
 * badge only when the vendor said something about the request, and an explicit
 * null is something — while an empty method is not. A build line carries no
 * badge at all rather than one full of nulls.
 *
 * **Where the verb is checked is observable.** All four routes check it first
 * and reach nothing, so a `GET` to the write door is a 405 even for a provider
 * that does not exist.
 *
 * **A broken percent-escape is not a decoded string.** The reference decodes
 * with `decodeURIComponent`, which throws — inside the `try`, so the reads
 * answer 500 and the write door answers 400.
 *
 * Usage:
 *   node --import tsx scripts/check-deploy-actions-parity.ts [--dump] <candidate> [args...]
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
    "Usage: node --import tsx scripts/check-deploy-actions-parity.ts [--dump] <candidate> [args...]",
  );
}

const VERCEL_PROJECT = {
  id: "prj_app",
  name: "app",
  framework: "nextjs",
  updatedAt: 1700000001000,
};

/**
 * The production deployment every action addresses. `target` is what a redeploy
 * has to carry through, so it is the field the recorded body is read for.
 */
const VERCEL_DEPLOYMENT = {
  uid: "dpl_one",
  name: "app",
  url: "app-one.vercel.app",
  readyState: "READY",
  target: "production",
  createdAt: 1700000000000,
  readyAt: 1700000030000,
  aliases: ["app.example.com"],
  buildingAt: 1700000005000,
  creator: { username: "acme-dev" },
  meta: {
    githubCommitRef: "main",
    githubCommitSha: "abc123",
    githubCommitMessage: "ship it",
    githubCommitAuthorName: "Acme Dev",
  },
  inspectorUrl: "https://vercel.com/acme/app/dpl_one",
};

/** A preview deployment: no target, so a redeploy of it must omit the field. */
const VERCEL_PREVIEW = {
  uid: "dpl_preview",
  name: "app",
  url: "app-preview.vercel.app",
  readyState: "READY",
  target: null,
  createdAt: 1700000010000,
};

/**
 * Vercel's build log is newline-delimited JSON events. The whitespace-only line
 * is here because it is *dropped* while still counting toward the next line's
 * fallback id — numbering after the filter would renumber everything past it.
 */
const VERCEL_BUILD_LOG = [
  JSON.stringify({
    type: "command",
    created: 1700000001000,
    payload: { id: "log_a", date: 1700000001000, text: "$ npm run build" },
  }),
  JSON.stringify({ type: "stdout", created: 1700000002000, payload: { text: "   " } }),
  JSON.stringify({
    type: "stderr",
    created: 1700000003000,
    // No payload id, so the fallback pairs the event's own `created` with the
    // position it arrived in — including the position the dropped line took.
    // The SGR codes are stripped; the trailing spaces go and the leading ones stay.
    payload: { text: "\u001b[31mError: build failed\u001b[0m   " },
  }),
].join("\n");

/**
 * Runtime lines chosen for their *presence*, not their text: one complete, one
 * with an explicit null status (which is a status), one with an empty method
 * (which is not a method) and only a `timestamp`, and one with nothing about
 * the request at all.
 */
const VERCEL_RUNTIME_LOG = [
  JSON.stringify({
    rowId: "row_a",
    timestampInMs: 1700000100000,
    level: "error",
    message: "500 on /api/checkout  ",
    source: "lambda",
    statusCode: 500,
    requestMethod: "POST",
    requestPath: "/api/checkout",
  }),
  JSON.stringify({
    requestId: "req_b",
    timestampInMs: 1700000101000,
    message: "slow response",
    statusCode: null,
  }),
  // No id and no `timestampInMs`: the fallback id reads that field only, so
  // this line is numbered by its position twice over even though `createdAt`
  // falls back to `timestamp`.
  JSON.stringify({
    timestamp: 1700000102000,
    level: "warning",
    message: "cold start",
    requestMethod: "",
  }),
  JSON.stringify({ timestampInMs: 1700000103000, message: "plain line" }),
  // Dropped: an empty message is not a line.
  JSON.stringify({ timestampInMs: 1700000104000, message: "   " }),
  "{ not json",
].join("\n");

const CF_PROJECT_PATH = "/accounts/acc_acme/pages/projects/app";

const CLOUDFLARE_PROJECT = {
  success: true,
  result: {
    id: "cf_app",
    name: "app",
    production_branch: "main",
    canonical_deployment: { id: "cfd_one" },
  },
};

const CLOUDFLARE_DEPLOYMENT = {
  success: true,
  result: {
    id: "cfd_one",
    url: "https://cfd-one.app.pages.dev",
    environment: "production",
    created_on: "2023-11-14T22:13:20Z",
    latest_stage: { name: "deploy", status: "success", ended_on: "2023-11-14T22:14:00Z" },
    deployment_trigger: {
      metadata: { branch: "main", commit_hash: "abc123", commit_message: "ship it" },
    },
  },
};

const API: StubRoute[] = [
  // --- project resolution ---
  { method: "GET", path: "/v9/projects/prj_app?teamId=team_acme", body: VERCEL_PROJECT },
  { method: "GET", path: CF_PROJECT_PATH, body: CLOUDFLARE_PROJECT },

  // --- Vercel reads ---
  {
    method: "GET",
    path: "/v13/deployments/dpl_one?withGitRepoInfo=true&teamId=team_acme",
    body: VERCEL_DEPLOYMENT,
  },
  {
    method: "GET",
    path: "/v13/deployments/dpl_preview?withGitRepoInfo=true&teamId=team_acme",
    body: VERCEL_PREVIEW,
  },
  {
    method: "GET",
    path: "/v13/deployments/dpl%20one?withGitRepoInfo=true&teamId=team_acme",
    body: { ...VERCEL_DEPLOYMENT, uid: "dpl one" },
  },
  {
    method: "GET",
    path: "/v13/deployments/dpl_missing?withGitRepoInfo=true&teamId=team_acme",
    status: 404,
    body: { error: { message: "Deployment not found." } },
  },
  {
    method: "GET",
    path: "/v3/deployments/dpl_one/events?builds=1&direction=backward&limit=500&teamId=team_acme",
    accept: "text/plain",
    contentType: "text/plain",
    body: VERCEL_BUILD_LOG,
  },
  {
    method: "GET",
    path: "/v3/deployments/dpl_one/events?builds=1&direction=backward&limit=2&teamId=team_acme",
    accept: "text/plain",
    contentType: "text/plain",
    body: VERCEL_BUILD_LOG,
  },
  {
    method: "GET",
    path: "/v3/deployments/dpl_one/events?builds=1&direction=backward&limit=2000&teamId=team_acme",
    accept: "text/plain",
    contentType: "text/plain",
    body: VERCEL_BUILD_LOG,
  },
  {
    method: "GET",
    path: "/v1/deployments/dpl_one/runtime-logs?limit=200&teamId=team_acme",
    accept: "text/plain",
    contentType: "text/plain",
    body: VERCEL_RUNTIME_LOG,
  },
  {
    method: "GET",
    path: "/v1/deployments/dpl_one/runtime-logs?limit=1000&teamId=team_acme",
    accept: "text/plain",
    contentType: "text/plain",
    body: VERCEL_RUNTIME_LOG,
  },

  // --- Vercel writes ---
  {
    method: "POST",
    path: "/v13/deployments?forceNew=1&teamId=team_acme",
    body: { id: "dpl_new", url: "app-new.vercel.app" },
  },
  { method: "PATCH", path: "/v12/deployments/dpl_one/cancel?teamId=team_acme", body: {} },
  { method: "PATCH", path: "/v12/deployments/dpl%20one/cancel?teamId=team_acme", body: {} },
  { method: "PATCH", path: "/v12/deployments/dpl_missing/cancel?teamId=team_acme", body: {} },
  { method: "POST", path: "/v10/projects/prj_app/promote/dpl_one?teamId=team_acme", body: {} },
  {
    method: "POST",
    // The team scope re-serializes the whole query as a form encoding, so the
    // description's spaces come back as `+` rather than as the `%20` the path
    // was written with.
    path: "/v1/projects/prj_app/rollback/dpl_one?description=rollback+from+NoMoreIDE&teamId=team_acme",
    body: {},
  },

  // --- Cloudflare ---
  { method: "GET", path: `${CF_PROJECT_PATH}/deployments/cfd_one`, body: CLOUDFLARE_DEPLOYMENT },
  {
    method: "GET",
    path: `${CF_PROJECT_PATH}/deployments/cfd_one/history/logs`,
    body: {
      success: true,
      result: {
        data: [
          { ts: "2023-11-14T22:13:20Z", line: "Cloning repository...  " },
          { ts: "2023-11-14T22:13:21Z", line: "   " },
          { line: "Build failed" },
        ],
      },
    },
  },
  {
    method: "POST",
    path: `${CF_PROJECT_PATH}/deployments/cfd_one/retry`,
    body: { success: true, result: { id: "cfd_new", url: "https://cfd-new.app.pages.dev" } },
  },
  {
    method: "POST",
    path: `${CF_PROJECT_PATH}/deployments/cfd_one/rollback`,
    // No `url`: a rollback names the deployment production now serves, and
    // Cloudflare does not always say where it serves from.
    body: { success: true, result: { id: "cfd_one" } },
  },
];

/** The same account, on a plan that is not entitled to runtime logs. */
const DEGRADED_API: StubRoute[] = [
  { method: "GET", path: "/v9/projects/prj_app?teamId=team_acme", body: VERCEL_PROJECT },
  {
    method: "GET",
    path: "/v13/deployments/dpl_one?withGitRepoInfo=true&teamId=team_acme",
    body: VERCEL_DEPLOYMENT,
  },
  {
    method: "GET",
    path: "/v1/deployments/dpl_one/runtime-logs?limit=200&teamId=team_acme",
    accept: "text/plain",
    status: 403,
    body: { error: { message: "Runtime logs require a Pro plan." } },
  },
  {
    method: "GET",
    path: "/v3/deployments/dpl_one/events?builds=1&direction=backward&limit=500&teamId=team_acme",
    accept: "text/plain",
    status: 502,
    body: { error: { message: "Build logs unavailable." } },
  },
  {
    method: "POST",
    path: "/v13/deployments?forceNew=1&teamId=team_acme",
    status: 402,
    body: { error: { message: "Deployment quota exceeded." } },
  },
];

interface Step {
  name: string;
  path: string;
  method?: string;
  /** Sort the recorded requests before comparing them. */
  concurrentRequests?: boolean;
  /**
   * This case is *meant* to reach the vendor for something the fixture does not
   * serve. Without it, a request the stub did not match fails the gate — a
   * fixture that quietly stopped matching would otherwise leave both runtimes
   * agreeing on a 404 and testing nothing.
   */
  unmatched?: boolean;
}

const VERCEL_STEPS: Step[] = [
  { name: "vercel/deployment/read", path: "/api/providers/vercel/deployments/dpl_one" },
  { name: "vercel/deployment/an-encoded-id", path: "/api/providers/vercel/deployments/dpl%20one" },
  { name: "vercel/deployment/a-broken-escape", path: "/api/providers/vercel/deployments/dpl%zz" },
  {
    name: "vercel/deployment/a-post-is-not-a-read",
    path: "/api/providers/vercel/deployments/dpl_one",
    method: "POST",
  },
  {
    name: "vercel/deployment/an-unknown-provider",
    path: "/api/providers/nowhere/deployments/dpl_one",
  },
  {
    name: "vercel/deployment/one-that-does-not-read",
    path: "/api/providers/vercel/deployments/dpl_missing",
  },

  { name: "vercel/logs/build", path: "/api/providers/vercel/deployments/dpl_one/logs" },
  {
    name: "vercel/logs/build-with-a-limit",
    path: "/api/providers/vercel/deployments/dpl_one/logs?limit=2",
  },
  {
    name: "vercel/logs/build-with-trailing-text",
    path: "/api/providers/vercel/deployments/dpl_one/logs?limit=2abc",
  },
  {
    name: "vercel/logs/build-with-a-limit-that-is-not-a-number",
    path: "/api/providers/vercel/deployments/dpl_one/logs?limit=abc",
  },
  {
    name: "vercel/logs/build-with-a-zero-limit",
    path: "/api/providers/vercel/deployments/dpl_one/logs?limit=0",
  },
  {
    name: "vercel/logs/build-over-the-cap",
    path: "/api/providers/vercel/deployments/dpl_one/logs?limit=99999",
  },
  {
    name: "vercel/logs/build-a-post-is-not-a-read",
    path: "/api/providers/vercel/deployments/dpl_one/logs",
    method: "POST",
  },
  {
    name: "vercel/logs/build-an-unknown-provider",
    path: "/api/providers/nowhere/deployments/dpl_one/logs",
  },

  { name: "vercel/logs/runtime", path: "/api/providers/vercel/deployments/dpl_one/runtime-logs" },
  {
    name: "vercel/logs/runtime-over-the-cap",
    path: "/api/providers/vercel/deployments/dpl_one/runtime-logs?limit=8000",
  },
  {
    name: "vercel/logs/runtime-a-post-is-not-a-read",
    path: "/api/providers/vercel/deployments/dpl_one/runtime-logs",
    method: "POST",
  },

  {
    name: "vercel/action/redeploy",
    path: "/api/providers/vercel/deployments/dpl_one/redeploy",
    method: "POST",
  },
  {
    name: "vercel/action/redeploy-a-preview",
    path: "/api/providers/vercel/deployments/dpl_preview/redeploy",
    method: "POST",
  },
  {
    name: "vercel/action/cancel",
    path: "/api/providers/vercel/deployments/dpl_one/cancel",
    method: "POST",
  },
  {
    name: "vercel/action/promote",
    path: "/api/providers/vercel/deployments/dpl_one/promote",
    method: "POST",
  },
  {
    name: "vercel/action/rollback",
    path: "/api/providers/vercel/deployments/dpl_one/rollback",
    method: "POST",
  },
  {
    name: "vercel/action/an-encoded-id",
    path: "/api/providers/vercel/deployments/dpl%20one/cancel",
    method: "POST",
  },
  {
    name: "vercel/action/a-broken-escape",
    path: "/api/providers/vercel/deployments/dpl%zz/cancel",
    method: "POST",
  },
  // The original will not read: `cancel` does not need it and must still run,
  // while `redeploy` does and must say which field it is missing.
  {
    name: "vercel/action/cancel-one-that-does-not-read",
    path: "/api/providers/vercel/deployments/dpl_missing/cancel",
    method: "POST",
  },
  {
    name: "vercel/action/redeploy-one-that-does-not-read",
    path: "/api/providers/vercel/deployments/dpl_missing/redeploy",
    method: "POST",
  },
  {
    name: "vercel/action/an-unknown-action",
    path: "/api/providers/vercel/deployments/dpl_one/publish",
    method: "POST",
  },
  // The action name is never decoded, so this is an unknown action rather than
  // a redeploy.
  {
    name: "vercel/action/an-escaped-action-name",
    path: "/api/providers/vercel/deployments/dpl_one/red%65ploy",
    method: "POST",
  },
  {
    name: "vercel/action/a-get-is-not-a-write",
    path: "/api/providers/vercel/deployments/dpl_one/redeploy",
    method: "GET",
    unmatched: true,
  },
  {
    name: "vercel/action/an-unknown-provider",
    path: "/api/providers/nowhere/deployments/dpl_one/redeploy",
    method: "POST",
  },
  {
    name: "vercel/action/a-get-on-an-unknown-provider",
    path: "/api/providers/nowhere/deployments/dpl_one/redeploy",
    method: "GET",
    unmatched: true,
  },
];

const CLOUDFLARE_STEPS: Step[] = [
  {
    name: "cloudflare/deployment/read",
    path: "/api/providers/cloudflare/deployments/cfd_one",
    concurrentRequests: true,
  },
  { name: "cloudflare/logs/build", path: "/api/providers/cloudflare/deployments/cfd_one/logs" },
  // Pages serves runtime output over a websocket tail, so it declares no such
  // capability: an empty list, and no request at all.
  {
    name: "cloudflare/logs/runtime-is-not-a-capability",
    path: "/api/providers/cloudflare/deployments/cfd_one/runtime-logs",
  },
  {
    name: "cloudflare/action/redeploy",
    path: "/api/providers/cloudflare/deployments/cfd_one/redeploy",
    method: "POST",
    concurrentRequests: true,
  },
  {
    name: "cloudflare/action/rollback",
    path: "/api/providers/cloudflare/deployments/cfd_one/rollback",
    method: "POST",
    concurrentRequests: true,
  },
  // Vercel's words, which Pages does not have.
  {
    name: "cloudflare/action/cancel-is-not-a-pages-action",
    path: "/api/providers/cloudflare/deployments/cfd_one/cancel",
    method: "POST",
  },
  {
    name: "cloudflare/action/promote-is-not-a-pages-action",
    path: "/api/providers/cloudflare/deployments/cfd_one/promote",
    method: "POST",
  },
];

/**
 * Nothing pinned. Vercel's ids are global, so the reads and the two actions
 * that address a deployment still work, and only the project-addressed pair
 * refuses.
 */
const UNPINNED_STEPS: Step[] = [
  { name: "unpinned/vercel/deployment", path: "/api/providers/vercel/deployments/dpl_one" },
  { name: "unpinned/vercel/logs", path: "/api/providers/vercel/deployments/dpl_one/logs" },
  {
    name: "unpinned/vercel/redeploy",
    path: "/api/providers/vercel/deployments/dpl_one/redeploy",
    method: "POST",
  },
  {
    name: "unpinned/vercel/cancel",
    path: "/api/providers/vercel/deployments/dpl_one/cancel",
    method: "POST",
  },
  {
    name: "unpinned/vercel/promote",
    path: "/api/providers/vercel/deployments/dpl_one/promote",
    method: "POST",
  },
  {
    name: "unpinned/vercel/rollback",
    path: "/api/providers/vercel/deployments/dpl_one/rollback",
    method: "POST",
  },
];

/** The same, for the provider that cannot address a deployment without one. */
const UNPINNED_CLOUDFLARE_STEPS: Step[] = [
  { name: "unpinned/cloudflare/deployment", path: "/api/providers/cloudflare/deployments/cfd_one" },
  { name: "unpinned/cloudflare/logs", path: "/api/providers/cloudflare/deployments/cfd_one/logs" },
  {
    name: "unpinned/cloudflare/redeploy",
    path: "/api/providers/cloudflare/deployments/cfd_one/redeploy",
    method: "POST",
  },
];

/** The vendor refusing each read on its own terms. */
const DEGRADED_STEPS: Step[] = [
  // 403 here means "your plan does not have these", not "you are not allowed":
  // an empty pane, not a failure.
  {
    name: "degraded/runtime-logs-are-not-entitled",
    path: "/api/providers/vercel/deployments/dpl_one/runtime-logs",
  },
  { name: "degraded/build-logs-refused", path: "/api/providers/vercel/deployments/dpl_one/logs" },
  {
    name: "degraded/redeploy-refused",
    path: "/api/providers/vercel/deployments/dpl_one/redeploy",
    method: "POST",
  },
];

const root = join(process.env.TMPDIR ?? "/tmp", `nomoreide-deploy-actions-${process.pid}`);
await mkdir(root, { recursive: true });
const harness = new RuntimeHarness(root);
const credentials = new Map<Runtime, string>();
const stubs: ApiStub[] = [];
let failures = 0;

/** Every secret the fixtures hold. None may appear where it was not asked for. */
const TOKENS = ["vercel-parity-token", "cloudflare-parity-token"];

async function send(runtime: Runtime, step: Step): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method ?? "GET",
    headers: { Authorization: `Bearer ${credentials.get(runtime) ?? ""}` },
  });
  const text = await response.text();
  for (const token of TOKENS) {
    if (text.includes(token)) {
      throw new Error(`${runtime.label} put a stored token in the answer to ${step.name}`);
    }
  }
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
  providers: ("vercel" | "cloudflare")[];
  pinned: boolean;
  plan: Step[];
  api?: StubRoute[];
}

async function walk({ label, providers, pinned, plan, api = API }: WalkOptions): Promise<void> {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      { ...spec, label: `${spec.label}-${label}` },
      (rt) => ({
        version: 1,
        connections: Object.fromEntries(
          providers.map((provider) => [
            provider,
            {
              source: "stored",
              token: `${provider}-parity-token`,
              scopeId: provider === "vercel" ? "team_acme" : "acc_acme",
            },
          ]),
        ),
        gitRepositories: [
          {
            name: "app",
            path: join(rt.workspace, "app"),
            ...(pinned
              ? {
                  providerProjects: Object.fromEntries(
                    providers.map((provider) => [
                      provider,
                      provider === "vercel" ? "prj_app" : "app",
                    ]),
                  ),
                }
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
    const stub = await startApiStub(api);
    stubs.push(stub);
    await harness.startDaemon(runtime, {
      NOMOREIDE_VERCEL_API_BASE: stub.base,
      NOMOREIDE_CLOUDFLARE_API_BASE: stub.base,
      // Keep a vendor CLI login on the machine running this out of the answer.
      XDG_DATA_HOME: join(runtime.home, ".local", "share"),
      WRANGLER_HOME: join(runtime.home, ".wrangler"),
      CLOUDFLARE_API_TOKEN: "",
      CF_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
      CF_ACCOUNT_ID: "",
    });
    credentials.set(
      runtime,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;
  const [referenceStub, candidateStub] = stubs.slice(-2);
  // Whatever each side did while resolving the project, compared per step below.
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
    const observe = (runtime: Runtime, stub: ApiStub) =>
      harness.recorded(runtime, step.name, async () => ({
        answer: await send(runtime, step),
        requests: requests(stub),
      }));
    const answers = {
      reference: await observe(reference, referenceStub),
      candidate: await observe(candidate, candidateStub),
    };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
    try {
      assert.deepStrictEqual(answers.candidate, answers.reference);
      // A case whose vendor request the fixture never matched is a case that
      // only proved both runtimes handle a 404 from the stub the same way.
      const missed = answers.reference.requests.filter((request) => !request.matched);
      if (!step.unmatched && missed.length > 0) {
        throw new Error(
          `the fixture does not serve ${missed
            .map((request) => `${request.method} ${request.path}`)
            .join(", ")}`,
        );
      }
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
  await walk({ label: "vercel", providers: ["vercel"], pinned: true, plan: VERCEL_STEPS });
  await walk({
    label: "cloudflare",
    providers: ["cloudflare"],
    pinned: true,
    plan: CLOUDFLARE_STEPS,
  });
  await walk({ label: "unpinned", providers: ["vercel"], pinned: false, plan: UNPINNED_STEPS });
  await walk({
    label: "unpinned-cloudflare",
    providers: ["cloudflare"],
    pinned: false,
    plan: UNPINNED_CLOUDFLARE_STEPS,
  });
  await walk({
    label: "degraded",
    providers: ["vercel"],
    pinned: true,
    plan: DEGRADED_STEPS,
    api: DEGRADED_API,
  });
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await rm(root, { recursive: true, force: true });
}

const total = [
  VERCEL_STEPS,
  CLOUDFLARE_STEPS,
  UNPINNED_STEPS,
  UNPINNED_CLOUDFLARE_STEPS,
  DEGRADED_STEPS,
].reduce((sum, plan) => sum + plan.length, 0);
if (failures > 0) {
  console.log(`\ndeploy-actions parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndeploy-actions parity: ${total} cases match`);
