/**
 * Phase 6 parity gate for the agent-environment registry sign-in:
 *
 *   GET  /api/agent-env/auth/status
 *   POST /api/agent-env/auth/start
 *   GET  /api/agent-env/auth/finish     (renders HTML, not JSON)
 *   GET  /api/agent-env/auth/outcome
 *   POST /api/agent-env/auth/logout
 *
 * **The registry is a stub this gate runs.** The flow is an OAuth-shaped
 * handshake against `api.nomoreide.com`, which no test may touch, so both
 * runtimes are pointed at a local server through `NOMOREIDE_API_BASE_URL`.
 * That server answers `/me` — accepting one token and rejecting the rest —
 * which is the whole of what the daemon asks of it.
 *
 * Two things here are easy to get subtly wrong and are gated closely:
 *
 * - `finish` returns **HTML**, and its status codes carry meaning: 400 for a
 *   state nobody issued, 401 for a token the registry rejects, 200 only when
 *   the token verified. A port that answered JSON would still "work" for the
 *   dashboard and break the browser tab the redirect lands in.
 * - a state is single-use for a *settled* outcome: reading a finished outcome
 *   forgets it, so the second read is `unknown` with a 404. That is what stops
 *   a stale tab from re-reporting an old sign-in.
 *
 * Usage:
 *   node --import tsx scripts/check-agent-auth-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";
import { volatile } from "../test/support/parity-recording.js";

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error("Usage: node --import tsx scripts/check-agent-auth-parity.ts [--dump] <candidate> [args...]");
}

/** The one token the stub registry accepts. */
const GOOD_TOKEN = "token-that-works";

/** A registry that answers `/me`, and nothing else. */
function startRegistry(): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    if (!request.url?.startsWith("/me")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (authorization !== `Bearer ${GOOD_TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        email: "someone@example.com",
        display_name: "Someone",
        avatar_url: null,
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      // This stub's port is the gate's, not a runtime's, so a recording would
      // otherwise keep the port it happened to get the day it was made — and
      // the normalization below, which erases *this* run's base, would leave
      // it standing.
      volatile(String(port));
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const credentials = new Map<Runtime, string>();
const auth = (runtime: Runtime): Record<string, string> => {
  const credential = credentials.get(runtime) ?? "";
  return credential ? { authorization: `Bearer ${credential}` } : {};
};

interface Answer {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function send(runtime: Runtime, method: string, path: string): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: auth(runtime),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* HTML stays text, which is the point for `finish` */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}

/** The sign-in state is a nonce; the daemon's own port is per-runtime. */
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
    // The callback is percent-encoded inside the sign-in URL, so the daemon's
    // own host appears twice in two spellings.
    .split(`127.0.0.1%3A${runtime.port}`)
    .join("<daemon>")
    // The sign-in state is a 32-character nonce. It appears as its own field,
    // as a query parameter, and again percent-encoded inside the callback —
    // so it is matched by shape rather than by the places it turns up.
    .replace(/[0-9a-f]{32}/g, "<state>");
  return JSON.parse(text);
}

const root = await mkdtemp(join(tmpdir(), "nmi-agent-auth-parity-"));
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
      runtime,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  const both = async (name: string, method: string, path: (runtime: Runtime) => string) => {
    compare(
      name,
      normalize(await send(reference, method, path(reference)), reference, registryBase),
      normalize(await send(candidate, method, path(candidate)), candidate, registryBase),
    );
  };

  await both("status/signed-out", "GET", () => "/api/agent-env/auth/status");
  await both("start/issues-a-url", "POST", () => "/api/agent-env/auth/start");
  await both("outcome/a-state-nobody-issued", "GET", () => "/api/agent-env/auth/outcome?state=nope");
  await both("outcome/no-state-at-all", "GET", () => "/api/agent-env/auth/outcome");
  await both("finish/a-state-nobody-issued", "GET", () => "/api/agent-env/auth/finish?state=nope&token=x");

  /** Start a sign-in, then finish it, using each runtime's own state. */
  async function handshake(
    name: string,
    finish: (state: string) => string,
    thenOutcome = true,
  ) {
    const answers = await Promise.all(
      runtimes.map(async (runtime) => {
        const started = (await send(runtime, "POST", "/api/agent-env/auth/start")) as {
          body: { state?: string };
        };
        const state = started.body.state ?? "";
        const finished = await send(runtime, "GET", finish(state));
        const outcome = thenOutcome
          ? await send(runtime, "GET", `/api/agent-env/auth/outcome?state=${encodeURIComponent(state)}`)
          : undefined;
        const again = thenOutcome
          ? await send(runtime, "GET", `/api/agent-env/auth/outcome?state=${encodeURIComponent(state)}`)
          : undefined;
        return normalize({ finished, outcome, again }, runtime, registryBase);
      }),
    );
    compare(name, answers[0], answers[1]);
  }

  await handshake("handshake/no-token-in-the-callback", (state) =>
    `/api/agent-env/auth/finish?state=${encodeURIComponent(state)}`,
  );
  await handshake("handshake/the-registry-said-error", (state) =>
    `/api/agent-env/auth/finish?state=${encodeURIComponent(state)}&error=access_denied`,
  );
  await handshake("handshake/a-token-the-registry-rejects", (state) =>
    `/api/agent-env/auth/finish?state=${encodeURIComponent(state)}&token=nope`,
  );
  await handshake("handshake/a-token-that-verifies", (state) =>
    `/api/agent-env/auth/finish?state=${encodeURIComponent(state)}&token=${GOOD_TOKEN}`,
  );

  // Signed in now, so status reports the user the stub registry describes.
  await both("status/signed-in", "GET", () => "/api/agent-env/auth/status");
  await both("logout/clears-it", "POST", () => "/api/agent-env/auth/logout");
  await both("status/after-logout", "GET", () => "/api/agent-env/auth/status");
} finally {
  server.close();
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.log(`\nagent-auth parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log("\nagent-auth parity: all cases match");
