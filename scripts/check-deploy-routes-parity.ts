/**
 * Parity gate for the deploy provider's non-OAuth dashboard routes:
 *
 *   GET     /api/providers/:provider/status
 *   POST    /api/providers/:provider/connect
 *   DELETE  /api/providers/:provider/connect
 *   PUT     /api/providers/:provider/scope
 *   GET|PUT /api/providers/:provider/project
 *   GET     /api/providers/:provider/projects
 *   GET     /api/providers/:provider/deployments
 *
 * `env`, `domains` and the OAuth pair are still the reference's; see the
 * Phase 8 section of `docs/plans/2026-08-20-native-rust-runtime-and-mcp.md`.
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
 * **A connected provider that refuses is a 200.** `status` reports the refusal
 * in a field, and which field depends on the *vendor's* HTTP status: 401 and
 * 403 are `auth_error`, everything else is `connection_error`. A port that read
 * the message instead would agree here and disagree the first time a vendor
 * reworded one, so the failure walks drive both statuses through both vendors.
 *
 * **Cloudflare identifies a scoped token by falling back.** A 4xx from `/user`
 * is not a failure — it is the signal to ask `/user/tokens/verify` instead and
 * name the token after its account. A 5xx is a real outage and must *not*
 * fall back. Both paths are walked, and the recorded requests are what
 * separates them.
 *
 * **Writes are compared by what they persisted, not only by what they
 * answered.** Every mutating step re-reads `config.json` from both homes, so a
 * `scope` that stored untrimmed spaces or a `project` pin that kept its
 * whitespace diverges even though both runtimes answered `{ ok: true }`.
 *
 * **Where the method check sits is observable.** `connect` looks the provider
 * up first, so a GET to an unknown provider is a 400 naming the provider;
 * `scope` checks the verb first, so the same request is a 405; `status` checks
 * no verb at all. Each is walked.
 *
 * **A token never reaches the wire.** Every answer is scanned for the stored
 * tokens, because two runtimes that both leaked one would otherwise agree.
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

/** Vercel's account record, as `/v2/user` wraps it. */
const VERCEL_USER = {
  user: {
    id: "usr_acme",
    username: "acme-dev",
    name: "Acme Dev",
    email: "dev@acme.test",
    avatar: "6f1de4",
  },
};

/** The teams the scope switcher offers, read through the *scoped* client. */
const SCOPED_TEAMS: StubRoute = {
  method: "GET",
  path: "/v2/teams?limit=100&teamId=team_acme",
  body: { teams: [{ id: "team_acme", slug: "acme", name: "Acme" }] },
};

/** Cloudflare's account record, for a credential that may read `/user`. */
const CLOUDFLARE_USER: StubRoute = {
  method: "GET",
  path: "/user",
  body: { success: true, result: { id: "cf_user", email: "dev@acme.test", username: "9f2c" } },
};

/**
 * The two reads the shared fixture has no reason to carry, plus the two
 * `limit` spellings these cases produce, plus the identity endpoints — which
 * it has no reason to carry either, because the MCP tools it was written for
 * never ask who the user is.
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
  { method: "GET", path: "/v2/user?teamId=team_acme", body: VERCEL_USER },
  SCOPED_TEAMS,
  CLOUDFLARE_USER,
];

const api = [...fixture.api, ...EXTRA];

/** Every secret the fixture homes hold. None of them may appear in an answer. */
const SECRETS = ["vercel-parity-token", "cloudflare-parity-token", "pasted-token"];

/** A vendor that rejects the credential outright, on every identity path. */
const AUTH_FAILURE_API: StubRoute[] = [
  {
    method: "GET",
    path: "/v9/projects/prj_app?teamId=team_acme",
    status: 401,
    body: { error: { message: "Not authorized." } },
  },
  {
    method: "GET",
    path: "/v2/user?teamId=team_acme",
    status: 401,
    body: { error: { message: "Not authorized." } },
  },
  { ...SCOPED_TEAMS, status: 401, body: { error: { message: "Not authorized." } } },
  // Cloudflare answers 403, and its `/user` fallback must reach a 403 too —
  // otherwise the token would be named rather than reported as rejected.
  { method: "GET", path: "/user", status: 403, body: { errors: [{ message: "Forbidden." }] } },
  {
    method: "GET",
    path: "/user/tokens/verify",
    status: 403,
    body: { errors: [{ message: "Forbidden." }] },
  },
  {
    method: "GET",
    path: "/accounts?per_page=50",
    status: 403,
    body: { errors: [{ message: "Forbidden." }] },
  },
  {
    method: "GET",
    path: "/accounts/acc_acme/pages/projects/app",
    status: 403,
    body: { errors: [{ message: "Forbidden." }] },
  },
];

/** A vendor that is down. Cloudflare must *not* fall back on a 5xx. */
const OUTAGE_API: StubRoute[] = [
  { method: "GET", path: "/v9/projects/prj_app?teamId=team_acme", body: PINNED_PROJECT },
  {
    method: "GET",
    path: "/v2/user?teamId=team_acme",
    status: 503,
    body: { error: { message: "Vercel is unavailable." } },
  },
  SCOPED_TEAMS,
  { method: "GET", path: "/user", status: 502, body: { errors: [{ message: "Bad gateway." }] } },
  { method: "GET", path: "/accounts?per_page=50", status: 200, body: { result: [] } },
];

/**
 * The half-working credential: Vercel answers who you are but not which teams
 * you have, and Cloudflare's token cannot read `/user` at all — the case its
 * `/user/tokens/verify` fallback exists for.
 */
const PARTIAL_API: StubRoute[] = [
  { method: "GET", path: "/v9/projects/prj_app?teamId=team_acme", body: PINNED_PROJECT },
  { method: "GET", path: "/v2/user?teamId=team_acme", body: VERCEL_USER },
  { ...SCOPED_TEAMS, status: 500, body: { error: { message: "Teams unavailable." } } },
  { method: "GET", path: "/user", status: 404, body: { errors: [{ message: "Not found." }] } },
  {
    method: "GET",
    path: "/user/tokens/verify",
    body: { success: true, result: { id: "tok_acme", status: "active" } },
  },
  {
    method: "GET",
    path: "/accounts?per_page=50",
    body: { success: true, result: [{ id: "acc_acme", name: "Acme Account" }] },
  },
  {
    method: "GET",
    path: "/accounts/acc_acme/pages/projects/app",
    body: { success: true, result: { id: "cf_app", name: "app" } },
  },
];

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
  /** Raw request body, sent verbatim. */
  body?: string;
  /** Defaults to the form encoding `connect` uses; JSON steps say so. */
  contentType?: string;
  /**
   * Cloudflare reads its canonical deployment alongside the listing, and
   * `status` reads the account and the scope list together — so the recorded
   * requests are sorted before they are compared rather than ordered.
   */
  concurrentRequests?: boolean;
  /** Also compare the persisted config after this step. */
  config?: boolean;
}

/** A JSON body, in the shape the `scope` and `project` routes read. */
function json(payload: unknown): Pick<Step, "body" | "contentType"> {
  return { body: JSON.stringify(payload), contentType: "application/json" };
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
  {
    name: "status/connected",
    path: "/api/providers/vercel/status",
    concurrentRequests: true,
  },
  {
    name: "status/a-delete-is-still-a-read",
    path: "/api/providers/vercel/status",
    method: "DELETE",
    concurrentRequests: true,
  },
  { name: "status/an-unknown-provider", path: "/api/providers/nowhere/status" },
  { name: "project/the-linked-one-in-full", path: "/api/providers/vercel/project" },
  {
    name: "project/a-post-is-neither-verb",
    path: "/api/providers/vercel/project",
    method: "POST",
  },
  { name: "project/an-unknown-provider", path: "/api/providers/nowhere/project" },
];

/** The same walk again with nothing pinned, so the no-project branch is real. */
const VERCEL_UNPINNED_STEPS: Step[] = [
  { name: "unpinned/deployments", path: "/api/providers/vercel/deployments" },
  { name: "unpinned/projects", path: "/api/providers/vercel/projects" },
  {
    name: "unpinned/status",
    path: "/api/providers/vercel/status",
    concurrentRequests: true,
  },
  { name: "unpinned/project", path: "/api/providers/vercel/project" },
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
  {
    name: "cloudflare/status",
    path: "/api/providers/cloudflare/status",
    concurrentRequests: true,
  },
  { name: "cloudflare/project", path: "/api/providers/cloudflare/project" },
];

const FAILURE_STEPS: Step[] = [
  { name: "failures/projects/vendor-refusal", path: "/api/providers/vercel/projects" },
  { name: "failures/deployments/vendor-refusal", path: "/api/providers/vercel/deployments" },
];

const DISCONNECTED_STEPS: Step[] = [
  { name: "disconnected/projects", path: "/api/providers/vercel/projects" },
  { name: "disconnected/deployments", path: "/api/providers/vercel/deployments" },
  // No connection and no CLI login: the panel gets a setup screen, not a
  // failure. Nothing reaches the vendor, so there is nothing to sort.
  { name: "disconnected/status", path: "/api/providers/vercel/status" },
  { name: "disconnected/project", path: "/api/providers/vercel/project" },
];

/**
 * The write half, walked in one order because each step is the state the next
 * one starts from — connect, re-scope, pin, unpin, disconnect. Every step that
 * changes something compares the persisted config, so an answer of `{ ok: true
 * }` over a different config is a failure.
 */
const CONNECTION_STEPS: Step[] = [
  {
    name: "connect/an-unknown-provider",
    path: "/api/providers/nowhere/connect",
    method: "POST",
  },
  { name: "connect/a-get-is-not-a-verb", path: "/api/providers/vercel/connect", method: "GET" },
  // The pair that separates the two orderings. `connect` looks the provider up
  // first, so this is a 400 naming the provider; `scope` checks the verb
  // first, so the same shape of request there is a 405. Swapping either check
  // is invisible to every other case in this walk.
  {
    name: "connect/an-unknown-provider-with-an-unknown-verb",
    path: "/api/providers/nowhere/connect",
    method: "GET",
  },
  {
    name: "connect/without-a-token",
    path: "/api/providers/vercel/connect",
    method: "POST",
    body: "",
  },
  {
    name: "connect/a-token-of-spaces",
    path: "/api/providers/vercel/connect",
    method: "POST",
    body: "token=%20%20",
  },
  {
    name: "connect/a-cli-login-that-is-not-there",
    path: "/api/providers/vercel/connect",
    method: "POST",
    body: "source=cli",
  },
  {
    name: "connect/a-pasted-token",
    path: "/api/providers/vercel/connect",
    method: "POST",
    body: "token=%20pasted-token%20",
    config: true,
  },
  // A pasted token arrives with no scope, and Vercel files a personal
  // account's projects under an implicit team — so an unscoped client lists
  // nothing at all, which reads as "no projects" rather than "wrong scope".
  // The sole team is adopted and *written back*, which is why this compares
  // the config: a port that adopted without persisting would answer
  // identically and re-ask the vendor on every request forever.
  {
    name: "status/after-a-pasted-token",
    path: "/api/providers/vercel/status",
    concurrentRequests: true,
    config: true,
  },
  { name: "scope/a-get-is-not-a-verb", path: "/api/providers/vercel/scope", method: "GET" },
  {
    name: "scope/an-unknown-provider-with-an-unknown-verb",
    path: "/api/providers/nowhere/scope",
    method: "GET",
  },
  {
    name: "scope/an-unknown-provider",
    path: "/api/providers/nowhere/scope",
    method: "PUT",
    ...json({ scopeId: "team_acme" }),
  },
  {
    name: "scope/a-chosen-team",
    path: "/api/providers/vercel/scope",
    method: "PUT",
    ...json({ scopeId: "team_acme", scopeSlug: "acme" }),
    config: true,
  },
  {
    name: "scope/spaces-clear-it",
    path: "/api/providers/vercel/scope",
    method: "PUT",
    ...json({ scopeId: "   ", scopeSlug: "   " }),
    config: true,
  },
  {
    name: "scope/a-non-string-is-no-scope",
    path: "/api/providers/vercel/scope",
    method: "PUT",
    ...json({ scopeId: 7 }),
    config: true,
  },
  {
    name: "scope/an-unreadable-body-is-an-empty-one",
    path: "/api/providers/vercel/scope",
    method: "PUT",
    body: "{not json",
    contentType: "application/json",
    config: true,
  },
  { name: "project/a-post-is-neither-verb", path: "/api/providers/vercel/project", method: "POST" },
  // `project` also looks the provider up first, and reports that refusal under
  // the status its *verb* implies — so an unknown provider is a 400 for a PUT
  // and a 500 for everything else, never a 405.
  {
    name: "project/an-unknown-provider-with-an-unknown-verb",
    path: "/api/providers/nowhere/project",
    method: "POST",
  },
  {
    name: "project/an-unknown-provider-put",
    path: "/api/providers/nowhere/project",
    method: "PUT",
    ...json({ projectId: "prj_app" }),
  },
  {
    name: "project/a-pin",
    path: "/api/providers/vercel/project",
    method: "PUT",
    ...json({ projectId: "prj_app" }),
    config: true,
  },
  {
    name: "project/a-pin-with-spaces",
    path: "/api/providers/vercel/project",
    method: "PUT",
    ...json({ projectId: "  prj_app  " }),
    config: true,
  },
  {
    name: "project/a-non-string-clears-it",
    path: "/api/providers/vercel/project",
    method: "PUT",
    ...json({ projectId: 7 }),
    config: true,
  },
  {
    name: "project/a-pin-again",
    path: "/api/providers/vercel/project",
    method: "PUT",
    ...json({ projectId: "prj_app" }),
  },
  {
    name: "project/and-clearing-drops-the-key",
    path: "/api/providers/vercel/project",
    method: "PUT",
    ...json({ projectId: "" }),
    config: true,
  },
  {
    name: "connect/disconnect",
    path: "/api/providers/vercel/connect",
    method: "DELETE",
    config: true,
  },
  { name: "connect/disconnect-again-is-still-ok", path: "/api/providers/vercel/connect", method: "DELETE" },
  {
    name: "connect/an-unknown-provider-delete",
    path: "/api/providers/nowhere/connect",
    method: "DELETE",
  },
  { name: "status/after-disconnecting", path: "/api/providers/vercel/status" },
  {
    name: "scope/without-a-connection",
    path: "/api/providers/vercel/scope",
    method: "PUT",
    ...json({ scopeId: "team_acme" }),
    config: true,
  },
];

/** A credential both vendors reject. */
const AUTH_FAILURE_STEPS: Step[] = [
  {
    name: "failures/status/vercel-rejected",
    path: "/api/providers/vercel/status",
    concurrentRequests: true,
  },
  {
    name: "failures/status/cloudflare-rejected",
    path: "/api/providers/cloudflare/status",
    concurrentRequests: true,
  },
];

/** Vendors that are down rather than refusing. */
const OUTAGE_STEPS: Step[] = [
  {
    name: "failures/status/vercel-unavailable",
    path: "/api/providers/vercel/status",
    concurrentRequests: true,
  },
  {
    name: "failures/status/cloudflare-unavailable",
    path: "/api/providers/cloudflare/status",
    concurrentRequests: true,
  },
];

/** Half-working credentials: no scope list, and no `/user`. */
const PARTIAL_STEPS: Step[] = [
  {
    name: "partial/status/vercel-without-scopes",
    path: "/api/providers/vercel/status",
    concurrentRequests: true,
  },
  {
    name: "partial/status/cloudflare-token-identity",
    path: "/api/providers/cloudflare/status",
    concurrentRequests: true,
  },
];

const root = join(process.env.TMPDIR ?? "/tmp", `nomoreide-deploy-routes-${process.pid}`);
await mkdir(root, { recursive: true });
const harness = new RuntimeHarness(root);
const credentials = new Map<Runtime, string>();
const stubs: ApiStub[] = [];
let failures = 0;

async function send(runtime: Runtime, step: Step): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.get(runtime) ?? ""}`,
  };
  if (step.body !== undefined) {
    headers["Content-Type"] = step.contentType ?? "application/x-www-form-urlencoded";
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method ?? "GET",
    headers,
    body: step.body,
  });
  const text = await response.text();
  for (const secret of SECRETS) {
    // Both runtimes leaking the same token would compare equal, so this is
    // asserted per answer rather than between them.
    if (text.includes(secret)) {
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

/**
 * The persisted config, with the runtime's own paths folded back to a
 * placeholder — two homes differ by construction, and that difference is not a
 * divergence.
 */
async function persistedConfig(runtime: Runtime): Promise<unknown> {
  const raw = await readFile(
    join(runtime.home, ".config", "nomoreide", "config.json"),
    "utf8",
  ).catch(() => "");
  return JSON.parse(raw.split(runtime.home).join("{{home}}") || "null");
}

type Provider = "vercel" | "cloudflare";

/** The scope and pinned project each provider's fixture connection carries. */
const FIXTURE: Record<Provider, { scopeId: string; project: string }> = {
  vercel: { scopeId: "team_acme", project: "prj_app" },
  cloudflare: { scopeId: "acc_acme", project: "app" },
};

interface WalkOptions {
  label: string;
  /** Which providers the fixture home is connected to. */
  providers: Provider[];
  pinned: boolean;
  plan: Step[];
  api?: StubRoute[];
  /**
   * Vendor paths whose request is fired and then abandoned, dropped from every
   * batch in this walk.
   *
   * `status` reads the account and the scope list together and discards the
   * scope list's failure. When the *account* is what fails, the reference
   * answers the moment it does — so whether the scope list's request has
   * reached the stub yet, and which step's batch it lands in, is a race with
   * no observable consequence: the result was thrown away either way. Both
   * runtimes send it. Comparing when it arrived would be comparing the
   * scheduler.
   */
  abandoned?: string[];
}

async function walk({
  label,
  providers,
  pinned,
  plan,
  api: stubRoutes = api,
  abandoned = [],
}: WalkOptions): Promise<void> {
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
              scopeId: FIXTURE[provider].scopeId,
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
                    providers.map((provider) => [provider, FIXTURE[provider].project]),
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
    const stub = await startApiStub(stubRoutes);
    stubs.push(stub);
    await harness.startDaemon(runtime, {
      // Both bases always, so a step that names either provider reaches the
      // stub rather than the real vendor.
      NOMOREIDE_VERCEL_API_BASE: stub.base,
      NOMOREIDE_CLOUDFLARE_API_BASE: stub.base,
      // Every place a vendor CLI login could be read from, pointed inside the
      // fixture home. Without this the gate's answer depends on whether the
      // machine running it happens to be logged into Vercel or Wrangler.
      XDG_DATA_HOME: join(runtime.home, ".local", "share"),
      WRANGLER_HOME: join(runtime.home, ".wrangler"),
      CLOUDFLARE_API_TOKEN: "",
      CF_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
      CF_ACCOUNT_ID: "",
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
      const observed = stub.take().filter((request) => !abandoned.includes(request.path));
      return step.concurrentRequests
        ? observed.toSorted((left, right) =>
            `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
          )
        : observed;
    };
    const answers = {
      reference: {
        answer: await send(reference, step),
        requests: requests(referenceStub),
        ...(step.config ? { config: await persistedConfig(reference) } : {}),
      },
      candidate: {
        answer: await send(candidate, step),
        requests: requests(candidateStub),
        ...(step.config ? { config: await persistedConfig(candidate) } : {}),
      },
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
  await walk({ label: "vercel-pinned", providers: ["vercel"], pinned: true, plan: VERCEL_STEPS });
  await walk({
    label: "vercel-unpinned",
    providers: ["vercel"],
    pinned: false,
    plan: VERCEL_UNPINNED_STEPS,
  });
  await walk({
    label: "cloudflare-pinned",
    providers: ["cloudflare"],
    pinned: true,
    plan: CLOUDFLARE_STEPS,
  });
  await walk({
    label: "vercel-failures",
    providers: ["vercel"],
    pinned: true,
    plan: FAILURE_STEPS,
    api: FAILURE_API,
  });
  await walk({
    label: "vercel-disconnected",
    providers: [],
    pinned: true,
    plan: DISCONNECTED_STEPS,
  });
  await walk({
    label: "vercel-connection",
    providers: ["vercel"],
    pinned: false,
    plan: CONNECTION_STEPS,
  });
  await walk({
    label: "auth-failures",
    providers: ["vercel", "cloudflare"],
    pinned: true,
    plan: AUTH_FAILURE_STEPS,
    api: AUTH_FAILURE_API,
    abandoned: ["/v2/teams?limit=100&teamId=team_acme"],
  });
  await walk({
    label: "outages",
    providers: ["vercel", "cloudflare"],
    pinned: true,
    plan: OUTAGE_STEPS,
    api: OUTAGE_API,
    abandoned: ["/v2/teams?limit=100&teamId=team_acme"],
  });
  await walk({
    label: "partial",
    providers: ["vercel", "cloudflare"],
    pinned: true,
    plan: PARTIAL_STEPS,
    api: PARTIAL_API,
  });
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await rm(root, { recursive: true, force: true });
}

const total = [
  VERCEL_STEPS,
  VERCEL_UNPINNED_STEPS,
  CLOUDFLARE_STEPS,
  FAILURE_STEPS,
  DISCONNECTED_STEPS,
  CONNECTION_STEPS,
  AUTH_FAILURE_STEPS,
  OUTAGE_STEPS,
  PARTIAL_STEPS,
].reduce((sum, plan) => sum + plan.length, 0);
if (failures > 0) {
  console.log(`\ndeploy-routes parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndeploy-routes parity: ${total} cases match`);
