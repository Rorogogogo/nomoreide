/**
 * Parity gate for the deploy provider's browser sign-in:
 *
 *   POST   /api/providers/:provider/oauth/start
 *   GET    /api/providers/:provider/oauth/callback
 *   GET    /api/providers/:provider/oauth/status
 *
 * The last unported piece of the provider surface, and the only stateful one:
 * **a sign-in spans three unrelated requests**, so every case here is a
 * *sequence* rather than a request. That is why this is its own gate — the
 * others compare one answer at a time, and nothing about them would notice a
 * runtime that answered each of these correctly while losing the thread
 * between them.
 *
 * The vendor here is a full OAuth authorization server stub: discovery,
 * dynamic client registration, and the token endpoint, reached because both
 * runtimes read `NOMOREIDE_VERCEL_OAUTH_ISSUER` — the same loopback-only
 * override the API base uses. Without it the token exchange and the connection
 * it writes are the one part of this flow nothing can reach without a real
 * Vercel account.
 *
 * What the cases are watching for:
 *
 * **The authorize URL is a contract, not a string.** PKCE means the challenge
 * must be the base64url SHA-256 of a verifier the runtime kept, and the two
 * runtimes cannot produce the same random values — so the URL is compared
 * *structurally*: same endpoint, same parameter names, same fixed values, and
 * the random ones merely present and well-formed. A challenge that was not
 * S256, or a scope that lost its `offline_access`, diverges.
 *
 * **The provider comes from the pending sign-in, not from the path.** A
 * callback carrying a `state` that was started under `vercel` stores tokens for
 * Vercel even when it arrives on another provider's path — and a `state` no
 * sign-in minted exchanges nothing at all. Both are checked by reading the
 * persisted config afterwards, because a runtime that wrote the connection
 * anyway would answer the same page.
 *
 * **A code is redeemable exactly once.** Replaying a callback that already
 * succeeded must not make a second token request; the recorded requests are the
 * only thing that shows it.
 *
 * **The phase is what the dashboard reads, and it is remembered across
 * requests.** `status` is polled between every step here. A disconnect resets
 * it — without that, a disconnect after a failed sign-in leaves the panel
 * showing that error for an account that is no longer connected.
 *
 * **`callback` answers HTML.** Its reader is a browser tab, so the body is
 * compared as text, escaping included: error text reaches that page from the
 * network and a runtime that interpolated it raw would be writing an injection
 * into a page it serves.
 *
 * **Where the verb is checked is observable.** `start` resolves the provider
 * *and* its OAuth spec before checking the verb, so a `GET` to a provider with
 * no browser sign-in is a 500 saying so rather than a 405 — and the 405 leaves
 * the phase alone where the 500 sets it to `error`.
 *
 * Usage:
 *   node --import tsx scripts/check-provider-oauth-parity.ts [--dump] <candidate> [args...]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    "Usage: node --import tsx scripts/check-provider-oauth-parity.ts [--dump] <candidate> [args...]",
  );
}

/**
 * The authorization server, as `/.well-known/openid-configuration` describes
 * it. The endpoints are absolute and point back at the stub, which is what lets
 * a runtime that ignored discovery and hard-coded `vercel.com` fail rather than
 * quietly reach the real one.
 */
const discovery = (base: string) => ({
  issuer: base,
  authorization_endpoint: `${base}/oauth/authorize`,
  token_endpoint: `${base}/oauth/token`,
  registration_endpoint: `${base}/oauth/register`,
  userinfo_endpoint: `${base}/oauth/userinfo`,
});

const TOKENS = {
  access_token: "oauth-access-token",
  refresh_token: "oauth-refresh-token",
  token_type: "Bearer",
  expires_in: 3600,
};

function oauthRoutes(base: string): StubRoute[] {
  return [
    { method: "GET", path: "/.well-known/openid-configuration", body: discovery(base) },
    { method: "POST", path: "/oauth/register", body: { client_id: "cl_parity" } },
    { method: "POST", path: "/oauth/token", body: TOKENS },
  ];
}

/** Enough of the API for `status` to report a connected account afterwards. */
const API: StubRoute[] = [
  { method: "GET", path: "/v2/user", body: { user: { id: "usr", username: "acme-dev" } } },
  { method: "GET", path: "/v2/teams?limit=100", body: { teams: [] } },
];

/** The authorization server refusing the exchange, as an expired code reads. */
const REJECTED_TOKEN: StubRoute = {
  method: "POST",
  path: "/oauth/token",
  status: 400,
  body: { error: "invalid_grant", error_description: "The code has expired" },
};

/** The authorization server with no registration endpoint at all. */
const NO_REGISTRATION = (base: string): StubRoute[] => [
  {
    method: "GET",
    path: "/.well-known/openid-configuration",
    body: { ...discovery(base), registration_endpoint: undefined },
  },
];

interface Step {
  name: string;
  path: string;
  method?: string;
  /** Compare the persisted config after this step. */
  config?: boolean;
  /**
   * Read the `state` out of the previous `start`'s authorize URL and splice it
   * into `path` where `{{state}}` appears — the one value the two runtimes
   * cannot agree on and the whole flow turns on.
   */
  usesState?: boolean;
}

const root = join(process.env.TMPDIR ?? "/tmp", `nomoreide-provider-oauth-${process.pid}`);
await mkdir(root, { recursive: true });
const harness = new RuntimeHarness(root);
const credentials = new Map<Runtime, string>();
const states = new Map<Runtime, string>();
/** Each runtime's own authorization server, so its base can be replaced too. */
const issuers = new Map<Runtime, string>();
/** The challenge each runtime last sent, checked against the verifier it redeems. */
const challenges = new Map<Runtime, string>();
const stubs: ApiStub[] = [];
let failures = 0;

/** Every secret the authorization server hands out. */
const SECRETS = [TOKENS.access_token, TOKENS.refresh_token];

async function send(runtime: Runtime, step: Step): Promise<unknown> {
  const path = step.usesState
    ? step.path.replace("{{state}}", encodeURIComponent(states.get(runtime) ?? ""))
    : step.path;
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: step.method ?? "GET",
    headers: { Authorization: `Bearer ${credentials.get(runtime) ?? ""}` },
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* the callback answers HTML, compared as the text it is */
  }

  // A `start` mints the state every later step needs, and it is the one value
  // the two runtimes must differ on.
  if (typeof body === "object" && body !== null && "url" in body) {
    const url = (body as { url?: unknown }).url;
    if (typeof url === "string") {
      const parameters = new URL(url).searchParams;
      states.set(runtime, parameters.get("state") ?? "");
      challenges.set(runtime, parameters.get("code_challenge") ?? "");
    }
  }

  for (const secret of SECRETS) {
    if (text.includes(secret)) {
      throw new Error(`${runtime.label} put an OAuth token in the answer to ${step.name}`);
    }
  }
  return { status: response.status, contentType, body: scrub(normalize(body), runtime) };
}

/**
 * The authorize URL, reduced to the part both runtimes must agree on.
 *
 * `state`, `code_challenge` and the client secret-adjacent values are random
 * per run, so they are replaced by an assertion about their *shape* — a
 * challenge is 43 base64url characters (a SHA-256 digest), a state is present.
 * Everything else, including the parameter order the URL was built in, is
 * compared verbatim.
 */
function normalize(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("url" in body)) return body;
  const raw = (body as { url?: unknown }).url;
  if (typeof raw !== "string") return body;
  const url = new URL(raw);
  const parameters: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key === "state") {
      parameters[key] = value.length >= 16 ? "<state>" : `<short:${value.length}>`;
    } else if (key === "code_challenge") {
      // Shape only here — a random 32-byte verifier is *also* 43 base64url
      // characters, so this cannot tell a digest from a plaintext challenge.
      // What proves S256 is `assertPkce` below, once the verifier is on the
      // wire at redemption time.
      parameters[key] = /^[A-Za-z0-9_-]{43}$/.test(value) ? "<s256>" : `<not-s256:${value}>`;
    } else {
      parameters[key] = value;
    }
  }
  return {
    ...(body as object),
    url: { origin: url.origin, pathname: url.pathname, parameters },
  };
}

/**
 * The stored config, with the runtime's own home replaced and the token's
 * expiry reduced to the claim that matters.
 *
 * `expiresAt` is `now + expires_in`, and the two runtimes redeem their codes
 * milliseconds apart — so comparing the instant would fail on timing rather
 * than on behaviour. What is worth checking is the *arithmetic*: that the
 * expiry came from the `expires_in` the server sent rather than from a
 * hard-coded hour or from the raw seconds written as milliseconds. So it is
 * compared as its distance from now, rounded to the minute.
 */
async function persistedConfig(runtime: Runtime): Promise<unknown> {
  const raw = await readFile(
    join(runtime.home, ".config", "nomoreide", "config.json"),
    "utf8",
  ).catch(() => "");
  if (!raw) return null;
  const parsed = JSON.parse(raw.split(runtime.home).join("{{home}}"));
  for (const connection of Object.values(parsed.connections ?? {})) {
    const stored = connection as { expiresAt?: unknown };
    if (typeof stored.expiresAt === "number") {
      const minutes = Math.round((stored.expiresAt - Date.now()) / 60_000);
      (stored as { expiresAt: unknown }).expiresAt = `<now+${minutes}m>`;
    }
  }
  return parsed;
}

/** The whole happy path, plus everything that must not disturb it. */
const CONNECT_STEPS: Step[] = [
  { name: "status/before-anything", path: "/api/providers/vercel/oauth/status" },
  // Resolves the provider and its spec before the verb, so this is a 405 that
  // leaves the phase alone.
  {
    name: "start/a-get-is-not-a-start",
    path: "/api/providers/vercel/oauth/start",
    method: "GET",
  },
  { name: "status/a-405-did-not-record-a-failure", path: "/api/providers/vercel/oauth/status" },
  {
    name: "start/an-unknown-provider",
    path: "/api/providers/nowhere/oauth/start",
    method: "POST",
  },
  { name: "status/an-unknown-provider", path: "/api/providers/nowhere/oauth/status" },
  // Cloudflare declares no OAuth: a 500 saying so, on either verb, because the
  // spec is resolved before the method is checked.
  {
    name: "start/a-provider-with-no-browser-sign-in",
    path: "/api/providers/cloudflare/oauth/start",
    method: "POST",
  },
  {
    name: "start/a-get-to-a-provider-with-no-browser-sign-in",
    path: "/api/providers/cloudflare/oauth/start",
    method: "GET",
  },
  { name: "status/cloudflare-recorded-the-refusal", path: "/api/providers/cloudflare/oauth/status" },

  { name: "start/mints-a-sign-in", path: "/api/providers/vercel/oauth/start", method: "POST" },
  { name: "status/pending", path: "/api/providers/vercel/oauth/status" },

  // A callback whose state no sign-in minted exchanges nothing, and — the point
  // of the `config` check — writes no connection.
  {
    name: "callback/an-unknown-state",
    path: "/api/providers/vercel/oauth/callback?code=c&state=not-a-real-state",
    config: true,
  },
  { name: "status/an-unknown-state-recorded-an-error", path: "/api/providers/vercel/oauth/status" },
  {
    name: "callback/no-code-at-all",
    path: "/api/providers/vercel/oauth/callback?state={{state}}",
    usesState: true,
  },
];

/**
 * A second sign-in, because the step above consumed the first one's state —
 * `take` forgets it whether or not a code came with it, which is itself the
 * contract.
 */
const REDEEM_STEPS: Step[] = [
  { name: "redeem/start", path: "/api/providers/vercel/oauth/start", method: "POST" },
  {
    name: "redeem/callback-succeeds",
    path: "/api/providers/vercel/oauth/callback?code=auth-code&state={{state}}",
    usesState: true,
    config: true,
  },
  { name: "redeem/status-is-connected", path: "/api/providers/vercel/oauth/status" },
  // A code is redeemable once: the state is gone, so this must reach no token
  // endpoint at all.
  {
    name: "redeem/callback-replayed",
    path: "/api/providers/vercel/oauth/callback?code=auth-code&state={{state}}",
    usesState: true,
    config: true,
  },
  { name: "redeem/status-after-the-replay", path: "/api/providers/vercel/oauth/status" },
  // Disconnecting clears the phase — otherwise the panel keeps reporting a
  // sign-in for an account that is gone.
  {
    name: "redeem/disconnect",
    path: "/api/providers/vercel/connect",
    method: "DELETE",
    config: true,
  },
  { name: "redeem/status-after-disconnect", path: "/api/providers/vercel/oauth/status" },
];

/**
 * A sign-in started under one provider whose callback arrives on another's
 * path.
 *
 * **The path is not what decides where the tokens go** — the pending sign-in
 * is. So this stores a *Vercel* connection even though it arrived on
 * Cloudflare's callback, and reports its outcome under `vercel`. A runtime
 * reading the provider out of the path would answer the same page while
 * writing the connection under the wrong provider, or refusing because
 * Cloudflare declares no OAuth at all — which is why the persisted config and
 * both phases are read afterwards rather than only the page.
 */
const CROSSED_STEPS: Step[] = [
  { name: "crossed/start-under-vercel", path: "/api/providers/vercel/oauth/start", method: "POST" },
  {
    name: "crossed/callback-arrives-on-cloudflares-path",
    path: "/api/providers/cloudflare/oauth/callback?code=auth-code&state={{state}}",
    usesState: true,
    config: true,
  },
  { name: "crossed/vercel-is-connected", path: "/api/providers/vercel/oauth/status" },
  { name: "crossed/cloudflare-was-not-touched", path: "/api/providers/cloudflare/oauth/status" },
];

/** The provider denying consent, and the error text reaching the page. */
const DENIED_STEPS: Step[] = [
  {
    name: "denied/the-user-said-no",
    path: "/api/providers/vercel/oauth/callback?error=access_denied&error_description=The+user+refused",
    config: true,
  },
  { name: "denied/status", path: "/api/providers/vercel/oauth/status" },
  // The description wins over the code when both are there.
  {
    name: "denied/only-a-code",
    path: "/api/providers/vercel/oauth/callback?error=server_error",
  },
  // Error text reaches this page from the network, so it must be escaped.
  {
    name: "denied/markup-in-the-error",
    path: "/api/providers/vercel/oauth/callback?error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
  },
  { name: "denied/status-holds-the-raw-text", path: "/api/providers/vercel/oauth/status" },
];

/** The authorization server refusing the exchange. */
const REJECTED_STEPS: Step[] = [
  { name: "rejected/start", path: "/api/providers/vercel/oauth/start", method: "POST" },
  {
    name: "rejected/the-code-was-refused",
    path: "/api/providers/vercel/oauth/callback?code=stale&state={{state}}",
    usesState: true,
    config: true,
  },
  { name: "rejected/status", path: "/api/providers/vercel/oauth/status" },
];

/** An authorization server that advertises no client registration. */
const UNREGISTRABLE_STEPS: Step[] = [
  { name: "unregistrable/start", path: "/api/providers/vercel/oauth/start", method: "POST" },
  { name: "unregistrable/status", path: "/api/providers/vercel/oauth/status" },
];

interface WalkOptions {
  label: string;
  plan: Step[];
  /** Built per runtime, because the endpoints name the stub's own base URL. */
  api: (base: string) => StubRoute[];
}

async function walk({ label, plan, api }: WalkOptions): Promise<void> {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      { ...spec, label: `${spec.label}-${label}` },
      () => ({
        version: 1,
        connections: {},
        gitRepositories: [],
        services: [],
        bundles: [],
        databases: [],
        sshServers: [],
      }),
      () => [],
    );
    // The routes name the stub's own base URL — discovery advertises absolute
    // endpoints, which is what lets a runtime that ignored discovery and
    // hard-coded `vercel.com` fail rather than quietly reach the real one. The
    // stub matches against this array per request, so it is filled once the
    // port it was given is known.
    const routes: StubRoute[] = [];
    const stub = await startApiStub(routes);
    routes.push(...api(stub.base));
    stubs.push(stub);
    issuers.set(runtime, stub.base);
    await harness.startDaemon(runtime, {
      NOMOREIDE_VERCEL_API_BASE: stub.base,
      NOMOREIDE_CLOUDFLARE_API_BASE: stub.base,
      NOMOREIDE_VERCEL_OAUTH_ISSUER: stub.base,
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
  referenceStub.take();
  candidateStub.take();

  for (const step of plan) {
    const observe = async (runtime: Runtime, stub: ApiStub) => harness.recorded(runtime, step.name, async () => {
      const answer = await send(runtime, step);
      const recorded = stub.take();
      assertPkce(recorded, runtime, step);
      // The registered redirect and the runtime's own port are per-runtime, so
      // the recorded requests are compared with both replaced.
      const requests = recorded.map((request) => ({
        ...request,
        body: scrub(request.body, runtime),
      }));
      return {
        answer,
        requests,
        ...(step.config ? { config: await persistedConfig(runtime) } : {}),
      };
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

/**
 * **The one thing PKCE is for**: that the challenge sent at authorize time is
 * the base64url SHA-256 of the verifier presented at redemption.
 *
 * Checked here rather than by comparing the two runtimes, because they must
 * differ on both values — so a runtime that sent its verifier *as* the
 * challenge (the plain method, which lets anyone who saw the redirect redeem
 * the code) would agree with the other on every compared field. This throws
 * instead, the way the token-leak scan does: two runtimes being wrong together
 * is still wrong.
 */
function assertPkce(requests: { path: string; body: unknown }[], runtime: Runtime, step: Step) {
  for (const request of requests) {
    if (!request.path.includes("/oauth/token")) continue;
    const verifier = new URLSearchParams(String(request.body ?? "")).get("code_verifier");
    if (!verifier) continue;
    const expected = createHash("sha256").update(verifier).digest("base64url");
    const challenge = challenges.get(runtime) ?? "";
    if (challenge !== expected) {
      throw new Error(
        `${runtime.label} redeemed ${step.name} with a verifier that is not the S256 preimage of the challenge it sent`,
      );
    }
  }
}

/**
 * Replaces the three values that cannot match between two runtimes: each one's
 * own daemon port (in the redirect URI it registers and redeems against),
 * its own authorization-server stub, and the PKCE verifier it minted.
 *
 * The port appears percent-encoded in a form body and plain in a JSON one, and
 * a recorded body is form-encoded text for the token endpoint and parsed JSON
 * for registration — so this works on the serialized form of either, and on an
 * answer as readily as on a request.
 */
function scrub(body: unknown, runtime: Runtime): unknown {
  const text = JSON.stringify(body);
  if (text === undefined) return body;
  const issuer = issuers.get(runtime) ?? "";
  const scrubbed = [
    [`127.0.0.1:${runtime.port}`, "{{daemon}}"],
    [`127.0.0.1%3A${runtime.port}`, "{{daemon}}"],
    [`localhost:${runtime.port}`, "{{daemon}}"],
    [`localhost%3A${runtime.port}`, "{{daemon}}"],
    ...(issuer
      ? ([
          [issuer, "{{issuer}}"],
          [encodeURIComponent(issuer), "{{issuer}}"],
        ] as [string, string][])
      : []),
  ]
    .reduce((carry, [needle, mark]) => carry.split(needle).join(mark), text)
    // The verifier is 32 random bytes, base64url. Present and well-formed is
    // the whole contract — its *value* is what PKCE requires the two runtimes
    // to differ on.
    .replace(/code_verifier(=|":")[A-Za-z0-9_-]+/g, "code_verifier$1<verifier>");
  return JSON.parse(scrubbed);
}

try {
  await walk({ label: "connect", plan: CONNECT_STEPS, api: (base) => [...oauthRoutes(base), ...API] });
  await walk({ label: "redeem", plan: REDEEM_STEPS, api: (base) => [...oauthRoutes(base), ...API] });
  await walk({
    label: "crossed",
    plan: CROSSED_STEPS,
    api: (base) => [...oauthRoutes(base), ...API],
  });
  await walk({ label: "denied", plan: DENIED_STEPS, api: (base) => [...oauthRoutes(base), ...API] });
  await walk({
    label: "rejected",
    plan: REJECTED_STEPS,
    api: (base) => [
      ...oauthRoutes(base).filter((route) => route.path !== "/oauth/token"),
      REJECTED_TOKEN,
      ...API,
    ],
  });
  await walk({
    label: "unregistrable",
    plan: UNREGISTRABLE_STEPS,
    api: (base) => [...NO_REGISTRATION(base), ...API],
  });
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

const total = [
  CONNECT_STEPS,
  REDEEM_STEPS,
  CROSSED_STEPS,
  DENIED_STEPS,
  REJECTED_STEPS,
  UNREGISTRABLE_STEPS,
].reduce((sum, plan) => sum + plan.length, 0);
if (failures > 0) {
  console.log(`\nprovider-oauth parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nprovider-oauth parity: ${total} cases match`);
