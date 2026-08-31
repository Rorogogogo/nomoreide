/**
 * Parity gate for the deploy provider's environment and domain routes:
 *
 *   GET            /api/providers/:provider/env
 *   POST           /api/providers/:provider/env
 *   POST           /api/providers/:provider/env/:env/reveal
 *   PATCH|DELETE   /api/providers/:provider/env/:env
 *   GET            /api/providers/:provider/domains
 *
 * Its own gate rather than more cases in `check-deploy-routes-parity.ts`,
 * because it needs a different vendor fixture: env vars and domains are the
 * one part of the surface where the two providers do not merely *word* things
 * differently, they store them somewhere else entirely.
 *
 * What the cases are watching for:
 *
 * **Cloudflare has no env-var endpoint.** Variables live inside the project's
 * `deployment_configs`, one map per environment, so the same key in production
 * and preview is two records there and one row here — and a key that is plain
 * text in one environment and a secret in the other is reported as a secret,
 * because the stricter of the two governs whether the value may be read. Every
 * write is a `PATCH` of the project, so the recorded request **bodies** are
 * compared: a port that sent a different patch would agree on the answer and
 * change something else on the account.
 *
 * **A secret's value is not an empty string.** Cloudflare never returns one,
 * and saying so is the answer — returning `""` renders as "this secret is
 * blank".
 *
 * **Cloudflare's `/domains` lists custom domains only**, so the assigned
 * `*.pages.dev` host is merged in from the project record, last, the way Vercel
 * orders its own. A failed *project* read degrades to the custom domains rather
 * than failing the panel.
 *
 * **Presence is contract.** Vercel reports `gitBranch` and `comment` even when
 * it has neither, and omits `createdAt` when it never sent one; Cloudflare
 * omits all four. A port that answered `null` everywhere would look right in a
 * dashboard and diverge here.
 *
 * **Where the verb is checked is observable, and so is what ran first.** `env`
 * resolves the provider context *before* checking the verb, so a `PUT` reaches
 * the vendor and then answers 405 — the recorded requests are what prove it.
 * `reveal` and the update/delete route check the verb first and reach nothing.
 *
 * **A broken percent-escape is a 400, not a decoded string.** The reference
 * decodes the id with `decodeURIComponent`, which throws.
 *
 * **A value is filtered, not validated.** `environments: ["production", 7]` is
 * a list of one, and an empty `value` on an update means "leave it alone"
 * rather than "set it to empty" — so neither reaches the vendor as written.
 *
 * Usage:
 *   node --import tsx scripts/check-provider-env-parity.ts [--dump] <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-provider-env-parity.ts [--dump] <candidate> [args...]",
  );
}

/** The Vercel project both runtimes resolve from the pinned id. */
const VERCEL_PROJECT = {
  id: "prj_app",
  name: "app",
  framework: "nextjs",
  updatedAt: 1700000001000,
};

/**
 * Four variables chosen for their *shapes*, not their names: a complete record,
 * one whose `target` is a bare string rather than a list, one with no id at all
 * (the key stands in), and one with no type (a secret, which is the answer that
 * cannot leak).
 */
const VERCEL_ENV = {
  envs: [
    {
      id: "env_b",
      key: "BETA",
      target: ["production", "preview"],
      type: "encrypted",
      gitBranch: null,
      comment: null,
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    },
    { id: "env_a", key: "ALPHA", target: "production", type: "plain" },
    { key: "GAMMA", target: [], type: "system", comment: "from vercel" },
    { id: "env_d", key: "DELTA", target: ["development"] },
  ],
};

/**
 * Two domains and four verification records, two of which name only half a DNS
 * record — half a record is not something a user can copy, and a row offering
 * one is worse than no row.
 */
const VERCEL_DOMAINS = {
  domains: [
    {
      name: "app.example.com",
      apexName: "example.com",
      verified: true,
      redirect: null,
      gitBranch: null,
      createdAt: 1700000000000,
      updatedAt: 1700000002000,
      verification: [],
    },
    {
      name: "www.example.com",
      verified: false,
      verification: [
        { type: "TXT", domain: "_vercel.www.example.com", value: "abc", reason: "pending" },
        { domain: "half.example.com" },
        { value: "orphan" },
        { domain: "d.example.com", value: "v" },
      ],
    },
  ],
};

/**
 * The Cloudflare project, carrying its variables the way Pages does. `SHARED`
 * is plain in production and a secret in preview, which is the case the merge
 * exists for; `REMOVED` is an explicit null, which is a variable Cloudflare has
 * been told to delete rather than one it holds.
 */
const CLOUDFLARE_PROJECT = {
  success: true,
  result: {
    id: "cf_app",
    name: "app",
    subdomain: "app.pages.dev",
    created_on: "2023-11-14T22:13:20Z",
    deployment_configs: {
      production: {
        env_vars: {
          SHARED: { type: "plain_text", value: "prod-value" },
          ONLY_PROD: { type: "secret_text" },
          PLAIN_ONLY: { type: "plain_text", value: "visible" },
          REMOVED: null,
        },
      },
      preview: {
        env_vars: {
          SHARED: { type: "secret_text", value: "preview-value" },
        },
      },
    },
  },
};

/** One PATCH answer serves every write case, so it carries both keys they touch. */
const CLOUDFLARE_PATCHED = {
  success: true,
  result: {
    deployment_configs: {
      production: {
        env_vars: {
          NEW_KEY: { type: "secret_text" },
          SHARED: { type: "plain_text", value: "prod-value" },
        },
      },
      preview: { env_vars: { NEW_KEY: { type: "secret_text" } } },
    },
  },
};

const CLOUDFLARE_DOMAINS = {
  success: true,
  result: [
    { name: "custom.example.com", status: "active", created_on: "2023-11-14T22:13:20Z" },
    {
      name: "pending.example.com",
      status: "pending",
      created_on: "2023-11-15T22:13:20Z",
      validation_data: {
        method: "txt",
        status: "pending",
        txt_name: "_cf.pending.example.com",
        txt_value: "tok",
      },
    },
    { name: "nothing.example.com", status: "pending" },
  ],
};

const CF_PROJECT_PATH = "/accounts/acc_acme/pages/projects/app";

const API: StubRoute[] = [
  // --- project resolution, so both runtimes find the pinned project ---
  { method: "GET", path: "/v9/projects/prj_app?teamId=team_acme", body: VERCEL_PROJECT },
  { method: "GET", path: CF_PROJECT_PATH, body: CLOUDFLARE_PROJECT },

  // --- Vercel env + domains ---
  { method: "GET", path: "/v9/projects/prj_app/env?limit=200&teamId=team_acme", body: VERCEL_ENV },
  {
    method: "GET",
    path: "/v9/projects/prj_app/env/env_a?teamId=team_acme",
    body: { id: "env_a", key: "ALPHA", value: "alpha-value" },
  },
  {
    method: "GET",
    path: "/v9/projects/prj_app/env/env%20space?teamId=team_acme",
    body: { id: "env space", key: "SPACED", value: "spaced-value" },
  },
  {
    method: "POST",
    path: "/v10/projects/prj_app/env?teamId=team_acme",
    body: {
      created: [
        {
          id: "env_new",
          key: "NEW_KEY",
          target: ["production", "preview"],
          type: "encrypted",
          createdAt: 1700000005000,
        },
      ],
    },
  },
  {
    method: "PATCH",
    path: "/v9/projects/prj_app/env/env_b?teamId=team_acme",
    body: {
      id: "env_b",
      key: "BETA",
      target: ["production"],
      type: "encrypted",
      updatedAt: 1700000009000,
    },
  },
  { method: "DELETE", path: "/v9/projects/prj_app/env/env_b?teamId=team_acme", body: {} },
  {
    method: "GET",
    path: "/v9/projects/prj_app/domains?limit=100&teamId=team_acme",
    body: VERCEL_DOMAINS,
  },

  // --- Cloudflare env + domains ---
  { method: "PATCH", path: CF_PROJECT_PATH, body: CLOUDFLARE_PATCHED },
  { method: "GET", path: `${CF_PROJECT_PATH}/domains`, body: CLOUDFLARE_DOMAINS },
];

/** The same vendor, refusing the project read every domain answer needs. */
const DEGRADED_API: StubRoute[] = [
  { method: "GET", path: "/v9/projects/prj_app?teamId=team_acme", body: VERCEL_PROJECT },
  { method: "GET", path: CF_PROJECT_PATH, body: CLOUDFLARE_PROJECT },
  { method: "GET", path: `${CF_PROJECT_PATH}/domains`, body: CLOUDFLARE_DOMAINS },
  {
    method: "GET",
    path: "/v9/projects/prj_app/env?limit=200&teamId=team_acme",
    status: 403,
    body: { error: { message: "Not authorized to read env." } },
  },
  {
    method: "GET",
    path: "/v9/projects/prj_app/domains?limit=100&teamId=team_acme",
    status: 500,
    body: { error: { message: "Domains unavailable." } },
  },
];

interface Step {
  name: string;
  path: string;
  method?: string;
  body?: string;
  contentType?: string;
  /** Sort the recorded requests before comparing them. */
  concurrentRequests?: boolean;
}

function json(payload: unknown): Pick<Step, "body" | "contentType"> {
  return { body: JSON.stringify(payload), contentType: "application/json" };
}

const VERCEL_STEPS: Step[] = [
  { name: "vercel/env/list", path: "/api/providers/vercel/env" },
  { name: "vercel/env/an-unknown-provider", path: "/api/providers/nowhere/env" },
  // Resolves the context and *then* refuses the verb — the recorded requests
  // are the only thing that shows it.
  { name: "vercel/env/a-put-is-neither-verb", path: "/api/providers/vercel/env", method: "PUT" },
  {
    name: "vercel/env/a-put-on-an-unknown-provider",
    path: "/api/providers/nowhere/env",
    method: "PUT",
  },

  { name: "vercel/domains/list", path: "/api/providers/vercel/domains" },
  { name: "vercel/domains/a-post-is-still-a-read", path: "/api/providers/vercel/domains", method: "POST" },
  { name: "vercel/domains/an-unknown-provider", path: "/api/providers/nowhere/domains" },

  {
    name: "vercel/reveal/a-get-is-not-a-verb",
    path: "/api/providers/vercel/env/env_a/reveal",
    method: "GET",
  },
  { name: "vercel/reveal/a-value", path: "/api/providers/vercel/env/env_a/reveal", method: "POST" },
  {
    name: "vercel/reveal/an-encoded-id",
    path: "/api/providers/vercel/env/env%20space/reveal",
    method: "POST",
  },
  {
    name: "vercel/reveal/a-broken-escape",
    path: "/api/providers/vercel/env/env%zz/reveal",
    method: "POST",
  },
  {
    name: "vercel/reveal/an-unknown-provider",
    path: "/api/providers/nowhere/env/env_a/reveal",
    method: "POST",
  },

  {
    name: "vercel/env/create",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ key: " NEW_KEY ", value: "secret", environments: ["production", "preview"] }),
  },
  {
    name: "vercel/env/create-plain",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ key: "NEW_KEY", value: "v", environments: ["production"], type: "plain" }),
  },
  {
    name: "vercel/env/create-with-an-unknown-type",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ key: "NEW_KEY", value: "v", environments: ["production"], type: "wat" }),
  },
  {
    name: "vercel/env/create-drops-non-string-environments",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ key: "NEW_KEY", value: "v", environments: ["production", 7, null] }),
  },
  {
    name: "vercel/env/create-without-a-key",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ value: "v", environments: ["production"] }),
  },
  {
    name: "vercel/env/create-with-a-key-of-spaces",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ key: "   ", value: "v", environments: ["production"] }),
  },
  {
    name: "vercel/env/create-without-environments",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ key: "NEW_KEY", value: "v", environments: [] }),
  },
  {
    name: "vercel/env/create-without-a-value",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ key: "NEW_KEY", environments: ["production"] }),
  },

  {
    name: "vercel/env/update",
    path: "/api/providers/vercel/env/env_b",
    method: "PATCH",
    ...json({ value: "rotated", environments: ["production"] }),
  },
  {
    name: "vercel/env/update-with-an-empty-value",
    path: "/api/providers/vercel/env/env_b",
    method: "PATCH",
    ...json({ value: "", environments: ["production"] }),
  },
  {
    name: "vercel/env/update-environments-only",
    path: "/api/providers/vercel/env/env_b",
    method: "PATCH",
    ...json({ environments: ["production"] }),
  },
  {
    name: "vercel/env/update-value-only",
    path: "/api/providers/vercel/env/env_b",
    method: "PATCH",
    ...json({ value: "rotated" }),
  },
  {
    name: "vercel/env/update-with-an-empty-body",
    path: "/api/providers/vercel/env/env_b",
    method: "PATCH",
    ...json({}),
  },
  { name: "vercel/env/delete", path: "/api/providers/vercel/env/env_b", method: "DELETE" },
  { name: "vercel/env/a-get-on-one-variable", path: "/api/providers/vercel/env/env_b", method: "GET" },
];

const CLOUDFLARE_STEPS: Step[] = [
  { name: "cloudflare/env/list", path: "/api/providers/cloudflare/env" },
  {
    name: "cloudflare/reveal/a-plain-value",
    path: "/api/providers/cloudflare/env/PLAIN_ONLY/reveal",
    method: "POST",
  },
  {
    name: "cloudflare/reveal/a-secret",
    path: "/api/providers/cloudflare/env/SHARED/reveal",
    method: "POST",
  },
  {
    name: "cloudflare/reveal/an-unknown-key",
    path: "/api/providers/cloudflare/env/NOPE/reveal",
    method: "POST",
  },
  {
    name: "cloudflare/reveal/a-deleted-key",
    path: "/api/providers/cloudflare/env/REMOVED/reveal",
    method: "POST",
  },
  // Two requests in flight together: the custom domains and the project the
  // assigned subdomain comes from.
  { name: "cloudflare/domains/list", path: "/api/providers/cloudflare/domains", concurrentRequests: true },
  {
    name: "cloudflare/env/create",
    path: "/api/providers/cloudflare/env",
    method: "POST",
    ...json({ key: "NEW_KEY", value: "secret", environments: ["production", "preview"] }),
  },
  {
    name: "cloudflare/env/create-plain",
    path: "/api/providers/cloudflare/env",
    method: "POST",
    ...json({ key: "NEW_KEY", value: "v", environments: ["production"], type: "plain" }),
  },
  // Pages has only two environments, and the dialog both providers share
  // offers three.
  {
    name: "cloudflare/env/create-in-an-environment-pages-lacks",
    path: "/api/providers/cloudflare/env",
    method: "POST",
    ...json({ key: "NEW_KEY", value: "v", environments: ["production", "development"] }),
  },
  {
    name: "cloudflare/env/update-a-value",
    path: "/api/providers/cloudflare/env/SHARED",
    method: "PATCH",
    ...json({ value: "rotated" }),
  },
  {
    name: "cloudflare/env/update-narrowing-environments",
    path: "/api/providers/cloudflare/env/SHARED",
    method: "PATCH",
    ...json({ value: "rotated", environments: ["production"] }),
  },
  // Adding an environment with no value has nothing to write there, because
  // Cloudflare never hands a secret's value back to copy across.
  {
    name: "cloudflare/env/update-adding-an-environment-without-a-value",
    path: "/api/providers/cloudflare/env/ONLY_PROD",
    method: "PATCH",
    ...json({ environments: ["production", "preview"] }),
  },
  {
    name: "cloudflare/env/update-an-unknown-key",
    path: "/api/providers/cloudflare/env/NOPE",
    method: "PATCH",
    ...json({ value: "v" }),
  },
  { name: "cloudflare/env/delete", path: "/api/providers/cloudflare/env/SHARED", method: "DELETE" },
  {
    name: "cloudflare/env/delete-an-unknown-key",
    path: "/api/providers/cloudflare/env/NOPE",
    method: "DELETE",
  },
];

/** Nothing pinned: every route here needs a project and says so. */
const UNPINNED_STEPS: Step[] = [
  { name: "unpinned/env", path: "/api/providers/vercel/env" },
  { name: "unpinned/domains", path: "/api/providers/vercel/domains" },
  { name: "unpinned/reveal", path: "/api/providers/vercel/env/env_a/reveal", method: "POST" },
  { name: "unpinned/delete", path: "/api/providers/vercel/env/env_a", method: "DELETE" },
  {
    name: "unpinned/create",
    path: "/api/providers/vercel/env",
    method: "POST",
    ...json({ key: "K", value: "v", environments: ["production"] }),
  },
];

/** The vendor refusing the reads themselves. */
const DEGRADED_STEPS: Step[] = [
  { name: "degraded/vercel/env", path: "/api/providers/vercel/env" },
  { name: "degraded/vercel/domains", path: "/api/providers/vercel/domains" },
];

const root = join(process.env.TMPDIR ?? "/tmp", `nomoreide-provider-env-${process.pid}`);
await mkdir(root, { recursive: true });
const harness = new RuntimeHarness(root);
const credentials = new Map<Runtime, string>();
const stubs: ApiStub[] = [];
let failures = 0;

/** Every secret the fixtures hold. None may appear where it was not asked for. */
const TOKENS = ["vercel-parity-token", "cloudflare-parity-token"];

async function send(runtime: Runtime, step: Step): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.get(runtime) ?? ""}`,
  };
  if (step.body !== undefined) {
    headers["Content-Type"] = step.contentType ?? "application/json";
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method ?? "GET",
    headers,
    body: step.body,
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
    const observe = async (runtime: Runtime, stub: ApiStub) => harness.recorded(runtime, step.name, async () => {
      const answer = await send(runtime, step);
      const observed = stub.take();
      const requests = step.concurrentRequests
        ? observed.toSorted((left, right) =>
            `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
          )
        : observed;
      return { answer, requests };
    });
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
    label: "degraded",
    providers: ["vercel"],
    pinned: true,
    plan: DEGRADED_STEPS,
    api: DEGRADED_API,
  });
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

const total = [VERCEL_STEPS, CLOUDFLARE_STEPS, UNPINNED_STEPS, DEGRADED_STEPS].reduce(
  (sum, plan) => sum + plan.length,
  0,
);
if (failures > 0) {
  console.log(`\nprovider-env parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nprovider-env parity: ${total} cases match`);
