/**
 * Phase 6 parity gate for the GitHub connection routes: the stored token, the
 * `gh` accounts, which account a repository speaks as, and the OAuth device
 * flow.
 *
 * These routes reach outward, so — like the MCP GitHub gate — each runtime is
 * pointed at its own loopback stand-in for `api.github.com` *and* for the
 * device-flow endpoints on `github.com`. The gate compares three things per
 * step: what the route answered, every request it made to get there, and (at
 * the end) the config each runtime saved. A route that echoed the right JSON
 * while storing the wrong token would pass on the first alone.
 *
 * The canned responses are mutated between steps, so one connection can be
 * walked through its whole life: no token, a token whose identity is unknown,
 * an account GitHub rejects, a repository it cannot see, and a device flow that
 * is still waiting.
 *
 * `gh` itself is the one thing not stubbed. Both runtimes shell out to whatever
 * `gh` this machine has — which is the point: the two must agree about it,
 * whether it is installed, signed in, or missing entirely.
 *
 * Usage:
 *   node --import tsx scripts/check-github-connection-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";
import { type ApiStub, type StubRoute, startApiStub } from "./support/http-api-stub.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });

/** The repository every runtime's workspace claims to be. */
const REMOTE = "https://github.com/acme/widgets.git";

const VIEWER = {
  login: "octocat",
  avatar_url: "https://avatars.example/octocat.png",
};
const REPO_INFO = {
  full_name: "acme/widgets",
  default_branch: "main",
  private: false,
  html_url: "https://github.com/acme/widgets",
};

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly form?: string;
  readonly json?: unknown;
  /** Rewrite the canned responses before either runtime is asked. */
  readonly arrange?: () => void;
  /**
   * Rewrite one runtime's config on disk before it is asked.
   *
   * For the states no route can reach: a `gh` credential is only ever written
   * after `gh` itself vouches for the account, which no gate can arrange on a
   * machine that may not have that account. The daemon re-reads config per
   * request, so planting one here is the same input a working `gh` would have
   * produced.
   */
  readonly plant?: (config: Record<string, unknown>) => void;
  /**
   * Compare only the status and the shape, replacing `error` with a marker.
   *
   * For the one accepted divergence here: a body that is not JSON at all is
   * reported through the parser's own words, and Node's and serde's differ.
   * Which status it produces, and that it produces one at all, still has to
   * match.
   */
  readonly maskError?: boolean;
}

/**
 * The canned API. Mutated in place between steps — both runtimes' stubs close
 * over this same array, so they always answer identically.
 */
const api: StubRoute[] = [];
/** The canned device flow, same arrangement. */
const oauth: StubRoute[] = [];

function serve(routes: StubRoute[], route: StubRoute): void {
  const index = routes.findIndex(
    (candidate) => candidate.method === route.method && candidate.path === route.path,
  );
  if (index === -1) routes.push(route);
  else routes[index] = route;
}

const user = (status: number, body: unknown) =>
  serve(api, { method: "GET", path: "/user", status, body });
const repoInfo = (status: number, body: unknown) =>
  serve(api, { method: "GET", path: "/repos/acme/widgets", status, body });
const deviceCode = (body: unknown, contentType?: string) =>
  serve(oauth, { method: "POST", path: "/login/device/code", body, contentType });
const accessToken = (body: unknown) =>
  serve(oauth, { method: "POST", path: "/login/oauth/access_token", body });

const steps: readonly Step[] = [
  // --- Nothing configured yet -----------------------------------------------
  { name: "status/not-configured", method: "GET", path: "/api/github/token" },
  { name: "accounts/from-gh", method: "GET", path: "/api/github/accounts" },

  // --- Storing a token ------------------------------------------------------
  { name: "token/no-body", method: "POST", path: "/api/github/token", form: "" },
  { name: "token/blank-token", method: "POST", path: "/api/github/token", form: "token=%20%20" },
  { name: "token/only-a-host", method: "POST", path: "/api/github/token", form: "host=github.com" },
  {
    name: "token/store-with-identity",
    method: "POST",
    path: "/api/github/token",
    form: "token=tok-one",
    arrange: () => user(200, VIEWER),
  },
  { name: "status/token-only", method: "GET", path: "/api/github/token" },
  // Re-storing without an identity must *clear* the old one, not keep it: a
  // new token can belong to a different person.
  {
    name: "token/store-when-identity-is-unavailable",
    method: "POST",
    path: "/api/github/token",
    form: "token=tok-two",
    arrange: () => user(500, { message: "Server Error" }),
  },
  { name: "status/identity-unavailable", method: "GET", path: "/api/github/token" },
  // With `/user` answering again, the next check backfills the identity.
  {
    name: "status/backfills-the-identity",
    method: "GET",
    path: "/api/github/token",
    arrange: () => user(200, VIEWER),
  },
  { name: "status/identity-is-cached", method: "GET", path: "/api/github/token" },

  // --- With a repository ----------------------------------------------------
  {
    name: "setup/register-the-repository",
    method: "POST",
    path: "/api/git/repositories",
    form: "name=widgets&path={{workspace}}",
  },
  {
    name: "status/connected",
    method: "GET",
    path: "/api/github/token",
    arrange: () => repoInfo(200, REPO_INFO),
  },
  {
    name: "status/repository-not-visible",
    method: "GET",
    path: "/api/github/token",
    arrange: () => repoInfo(404, { message: "Not Found" }),
  },
  {
    name: "status/credential-rejected",
    method: "GET",
    path: "/api/github/token",
    arrange: () => repoInfo(401, { message: "Bad credentials" }),
  },
  {
    name: "status/forbidden",
    method: "GET",
    path: "/api/github/token",
    arrange: () => repoInfo(403, { message: "Resource not accessible" }),
  },
  {
    name: "status/github-broken",
    method: "GET",
    path: "/api/github/token",
    arrange: () => repoInfo(500, { message: "Server Error" }),
  },

  // --- Choosing an account --------------------------------------------------
  { name: "account/no-body", method: "PUT", path: "/api/github/account" },
  { name: "account/no-credential", method: "PUT", path: "/api/github/account", json: { repository: "widgets" } },
  {
    name: "account/credential-is-a-string",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "widgets", credential: "gh" },
  },
  // An array is `typeof "object"` too, so it gets past the "is it there" check
  // and is refused for its source instead.
  {
    name: "account/credential-is-an-array",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "widgets", credential: [] },
  },
  {
    name: "account/credential-is-null",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "widgets", credential: null },
  },
  {
    name: "account/no-repository",
    method: "PUT",
    path: "/api/github/account",
    json: { credential: { source: "stored", host: "github.com" } },
  },
  {
    name: "account/blank-repository",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "   ", credential: { source: "stored", host: "github.com" } },
  },
  {
    name: "account/enterprise-host",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "widgets", credential: { source: "stored", host: "enterprise.example" } },
  },
  {
    name: "account/unsupported-source",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "widgets", credential: { source: "basic", host: "github.com" } },
  },
  {
    name: "account/gh-without-a-login",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "widgets", credential: { source: "gh", host: "github.com" } },
  },
  {
    name: "account/gh-without-a-host",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "widgets", credential: { source: "gh", login: "octocat" } },
  },
  // A login `gh` cannot speak for. Whatever this machine's `gh` says about it,
  // both runtimes have to say the same.
  {
    name: "account/gh-account-this-machine-does-not-have",
    method: "PUT",
    path: "/api/github/account",
    json: {
      repository: "widgets",
      credential: { source: "gh", host: "github.com", login: "nmi-gate-no-such-account" },
    },
  },
  {
    name: "account/stored",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "widgets", credential: { source: "stored", host: "github.com" } },
  },
  {
    name: "account/unregistered-repository",
    method: "PUT",
    path: "/api/github/account",
    json: { repository: "never-registered", credential: { source: "stored", host: "github.com" } },
  },
  {
    name: "status/after-choosing-stored",
    method: "GET",
    path: "/api/github/token",
    arrange: () => repoInfo(200, REPO_INFO),
  },

  // --- Device flow: starting ------------------------------------------------
  {
    name: "oauth/start",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () =>
      deviceCode({
        device_code: "dev-code-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=ABCD-1234",
        expires_in: 600,
        interval: 7,
      }),
  },
  // Everything optional missing: the completed URL falls back to the plain one
  // and the two timings take their defaults.
  {
    name: "oauth/start-minimal",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () =>
      deviceCode({ device_code: "dev-code-2", verification_uri: "https://github.com/login/device" }),
  },
  { name: "oauth/start-empty-payload", method: "POST", path: "/api/github/oauth/start", arrange: () => deviceCode({}) },
  // An explicit null must not beat the default, and a zero must.
  {
    name: "oauth/start-null-and-zero",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () =>
      deviceCode({ device_code: "dev-code-3", verification_uri_complete: null, expires_in: 0, interval: null }),
  },
  {
    name: "oauth/start-refused",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () => deviceCode({ error: "unauthorized_client", error_description: "This app cannot use the device flow." }),
  },
  {
    name: "oauth/start-refused-without-a-description",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () => deviceCode({ error: "unauthorized_client" }),
  },
  // An empty `error` is not an error — the reference branches on truthiness.
  {
    name: "oauth/start-empty-error",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () => deviceCode({ error: "", device_code: "dev-code-4" }),
  },
  // GitHub is trusted to send strings, but nothing *checks* that it did — the
  // reference copies these fields across untyped, so a number stays a number
  // and an explicit null stays null.
  {
    name: "oauth/start-unexpected-types",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () =>
      deviceCode({ device_code: 42, user_code: null, verification_uri: { href: "x" } }),
  },
  // A null description is a missing one, so the machine code answers instead.
  {
    name: "oauth/start-refused-with-a-null-description",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () => deviceCode({ error: "device_flow_disabled", error_description: null }),
  },
  {
    name: "oauth/start-not-json",
    method: "POST",
    path: "/api/github/oauth/start",
    arrange: () => deviceCode("that is not json", "text/plain"),
    maskError: true,
  },

  // --- Device flow: polling -------------------------------------------------
  { name: "oauth/poll-no-body", method: "POST", path: "/api/github/oauth/poll" },
  { name: "oauth/poll-empty-device-code", method: "POST", path: "/api/github/oauth/poll", json: { device_code: "" } },
  { name: "oauth/poll-numeric-device-code", method: "POST", path: "/api/github/oauth/poll", json: { device_code: 42 } },
  { name: "oauth/poll-garbage-body", method: "POST", path: "/api/github/oauth/poll", form: "device_code=dev-code-1" },
  {
    name: "oauth/poll-pending",
    method: "POST",
    path: "/api/github/oauth/poll",
    json: { device_code: "dev-code-1" },
    arrange: () => accessToken({ error: "authorization_pending" }),
  },
  {
    name: "oauth/poll-slow-down",
    method: "POST",
    path: "/api/github/oauth/poll",
    json: { device_code: "dev-code-1" },
    arrange: () => accessToken({ error: "slow_down" }),
  },
  {
    name: "oauth/poll-denied",
    method: "POST",
    path: "/api/github/oauth/poll",
    json: { device_code: "dev-code-1" },
    arrange: () => accessToken({ error: "access_denied", error_description: "The user cancelled." }),
  },
  {
    name: "oauth/poll-nothing-at-all",
    method: "POST",
    path: "/api/github/oauth/poll",
    json: { device_code: "dev-code-1" },
    arrange: () => accessToken({}),
  },
  // An empty token is not a token: the reference tests it for truthiness.
  {
    name: "oauth/poll-empty-token",
    method: "POST",
    path: "/api/github/oauth/poll",
    json: { device_code: "dev-code-1" },
    arrange: () => accessToken({ access_token: "" }),
  },
  // The poll route does *not* gate on truthiness the way `start` does: an empty
  // `error` is still a refusal here, and it is reported as the empty string
  // GitHub sent rather than as our own wording.
  {
    name: "oauth/poll-empty-error",
    method: "POST",
    path: "/api/github/oauth/poll",
    json: { device_code: "dev-code-1" },
    arrange: () => accessToken({ error: "" }),
  },
  {
    name: "oauth/poll-null-description",
    method: "POST",
    path: "/api/github/oauth/poll",
    json: { device_code: "dev-code-1" },
    arrange: () => accessToken({ error: "expired_token", error_description: null }),
  },
  {
    name: "oauth/poll-authorized",
    method: "POST",
    path: "/api/github/oauth/poll",
    json: { device_code: "dev-code-1" },
    arrange: () => accessToken({ access_token: "tok-from-device-flow", token_type: "bearer" }),
  },
  { name: "status/after-the-device-flow", method: "GET", path: "/api/github/token" },

  // --- Removing a token -----------------------------------------------------
  { name: "token/remove-unknown-host", method: "DELETE", path: "/api/github/token/enterprise.example" },
  // Escaped, because the host arrives through the path. This call answers
  // `{ok:true}` whether or not it removed anything, so what it *did* is
  // observed by the status check below: a host that failed to decode would
  // leave the connection intact.
  { name: "token/remove-percent-encoded", method: "DELETE", path: "/api/github/token/github%2Ecom" },
  { name: "status/after-removal", method: "GET", path: "/api/github/token" },
  { name: "token/remove-wrong-method", method: "GET", path: "/api/github/token/github.com" },

  // --- A `gh` account, planted ----------------------------------------------
  // No stored token now, so `configured` can only be true because the selected
  // repository borrows an account from the CLI.
  {
    name: "status/gh-credential-no-stored-token",
    method: "GET",
    path: "/api/github/token",
    plant: (config) => {
      config.gitRepositories = [
        {
          name: "widgets",
          path: (config.gitRepositories as Array<{ path: string }>)[0].path,
          githubCredential: { source: "gh", host: "github.com", login: "nmi-gate-no-such-account" },
        },
      ];
      config.githubTokens = [];
    },
  },
  // The same credential, now against a host it does not speak for.
  {
    name: "status/gh-credential-for-another-host",
    method: "GET",
    path: "/api/github/token",
    plant: (config) => {
      config.gitRepositories = [
        {
          name: "widgets",
          path: (config.gitRepositories as Array<{ path: string }>)[0].path,
          githubCredential: { source: "stored", host: "enterprise.example" },
        },
      ];
    },
  },


  // --- Avatars we have to build ourselves -----------------------------------
  // An account GitHub named but gave no picture for: the avatar is derived
  // from the login, and the derived URL is compared character for character.
  {
    name: "setup/token-for-an-account-with-no-avatar",
    method: "POST",
    path: "/api/github/token",
    form: "token=tok-avatar",
    arrange: () => user(200, { login: "no-avatar-user" }),
    plant: (config) => {
      config.gitRepositories = [];
      config.githubTokens = [];
    },
  },
  { name: "status/avatar-derived-from-the-login", method: "GET", path: "/api/github/token" },
  // A login that has to be escaped on the way into a URL.
  {
    name: "setup/token-for-an-account-needing-escaping",
    method: "POST",
    path: "/api/github/token",
    form: "token=tok-escape",
    arrange: () => user(200, { login: "we ird/name+x" }),
    plant: (config) => {
      config.githubTokens = [];
    },
  },
  { name: "status/avatar-escapes-the-login", method: "GET", path: "/api/github/token" },
  // An account GitHub answers for but does not name. The identity backfill
  // rejects it, so the connection check asks a second time and then reads the
  // payload without checking — which is how the word "undefined" ends up in an
  // avatar URL. Reproduced rather than corrected; see the route's comment.
  {
    name: "setup/token-for-an-unnamed-account",
    method: "POST",
    path: "/api/github/token",
    form: "token=tok-nameless",
    arrange: () => user(200, {}),
    plant: (config) => {
      config.githubTokens = [];
    },
  },
  { name: "status/account-github-would-not-name", method: "GET", path: "/api/github/token" },
];

const dump = process.argv.includes("--dump");
const argv = process.argv.slice(2).filter((value) => value !== "--dump");
if (argv.length === 0) {
  console.error("Usage: check-github-connection-parity.ts <candidate> [args...]");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "nmi-github-connection-parity-"));
const harness = new RuntimeHarness(root);
const stubs: ApiStub[] = [];
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], gitRepositories: [] }),
      () => [],
    );
    await seedWorkspace(runtime);
    const apiStub = await startApiStub(api);
    const oauthStub = await startApiStub(oauth);
    stubs.push(apiStub, oauthStub);
    await harness.startDaemon(runtime, {
      NOMOREIDE_GITHUB_API_BASE: apiStub.base,
      NOMOREIDE_GITHUB_OAUTH_BASE: oauthStub.base,
    });
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;
  // stubs are pushed api-then-oauth per runtime, in runtime order.
  const outbound = (index: number) => [stubs[index * 2], stubs[index * 2 + 1]];

  for (const step of steps) {
    step.arrange?.();
    if (step.plant) {
      for (const runtime of runtimes) await plant(runtime, step.plant);
    }
    for (const stub of stubs) stub.take();

    // One unit per runtime: the answer and the requests it caused are the
    // comparison, and in replay the reference's side comes from the recording
    // rather than from a process that no longer exists.
    //
    // A replayed reference is still *sent* the request first. Half of what
    // this gate checks is the config file the daemon leaves behind, and the
    // final reads below open it on disk — so the request has to reach the
    // replay server, which drives a native shadow over the reference's own
    // fixture and makes those writes happen. Only the answer and the vendor
    // calls come from the recording: what the shadow asks the stub is the
    // candidate's behaviour, so it is drained and thrown away rather than
    // compared against itself.
    const observe = async (runtime: Runtime, side: 0 | 1) => {
      if (harness.replayed(runtime)) {
        await send(runtime, step);
        for (const stub of outbound(side)) stub.take();
      }
      return harness.recorded(runtime, step.name, async () => ({
        answer: await send(runtime, step),
        requests: outbound(side).flatMap((stub) => stub.take()),
      }));
    };
    const reference_ = await observe(reference, 0);
    const candidate_ = await observe(candidate, 1);
    const answers = { reference: reference_.answer, candidate: candidate_.answer };
    const requests = { reference: reference_.requests, candidate: candidate_.requests };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect({ ...answers.reference, requests: requests.reference }, { depth: null })}`);
      console.log(`  candidate: ${inspect({ ...answers.candidate, requests: requests.candidate }, { depth: null })}`);
    }
    const observed = (side: "reference" | "candidate", runtime: Runtime) => ({
      answer: mask(step, normalizePaths(answers[side], runtime)),
      requests: requests[side],
    });
    compare(step.name, observed("candidate", candidate), observed("reference", reference));
  }

  for (const [name, read] of finalReads()) {
    compare(name, await read(candidate), await read(reference));
  }
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close()));
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

const total = steps.length + finalReads().length;
console.log(
  failures === 0
    ? `\ngithub-connection parity: ${total} cases match`
    : `\ngithub-connection parity: ${failures} case(s) diverged`,
);
process.exit(failures === 0 ? 0 : 1);

function compare(name: string, candidate: unknown, reference: unknown): void {
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

function finalReads(): Array<[string, (runtime: Runtime) => Promise<unknown>]> {
  return [
    [
      "config/github",
      async (runtime) => {
        const raw = await readFile(join(runtime.home, ".config", "nomoreide", "config.json"), "utf8");
        const config = JSON.parse(raw);
        return {
          tokens: config.githubTokens ?? [],
          repositories: (config.gitRepositories ?? []).map(
            (repository: { name: string; githubCredential?: unknown }) => ({
              name: repository.name,
              credential: repository.githubCredential ?? "<none>",
            }),
          ),
        };
      },
    ],
  ];
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** Rewrite one runtime's config file in place. */
async function plant(
  runtime: Runtime,
  edit: (config: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(runtime.home, ".config", "nomoreide", "config.json");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  edit(config);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** A workspace that is a git repository with a GitHub remote. */
async function seedWorkspace(runtime: Runtime): Promise<void> {
  const workspace = runtime.workspace;
  await git(workspace, "init", "--quiet", "--initial-branch", "main");
  await git(workspace, "config", "user.email", "gate@example.com");
  await git(workspace, "config", "user.name", "Gate");
  await git(workspace, "remote", "add", "origin", REMOTE);
  await run("sh", ["-c", `printf 'seed\\n' > ${JSON.stringify(join(workspace, "readme.txt"))}`]);
  await git(workspace, "add", "-A");
  await git(workspace, "commit", "--quiet", "-m", "first");
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  let body: string | undefined;
  if (step.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(step.json);
  } else if (step.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = step.form.split("{{workspace}}").join(encodeURIComponent(runtime.workspace));
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
    body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, body: parsed };
}

function mask(step: Step, answer: Answer): Answer {
  if (!step.maskError) return answer;
  const body = answer.body;
  if (body === null || typeof body !== "object") return answer;
  return { ...answer, body: { ...(body as object), error: "<parser wording>" } };
}

function erase(value: string, runtime: Runtime): string {
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

function normalizePaths(answer: Answer, runtime: Runtime): Answer {
  return { ...answer, body: JSON.parse(erase(JSON.stringify(answer.body), runtime)) };
}
