/**
 * Phase 6 parity gate for the per-service HTTP inspector:
 *
 *   POST /api/services/:name/inspector
 *
 * One endpoint that starts a whole second server. Enabling it stands a
 * reverse proxy in front of the service's own port and records every request
 * that passes through onto the timeline; disabling it takes the proxy down.
 * So the gate does not stop at the JSON — it **drives traffic through the
 * proxy it was just handed** and reads the timeline back, because a port
 * number in a response proves nothing about what is listening on it.
 *
 * Four things are gated closely:
 *
 * - **The proxy is transparent.** Status, body and the upstream's view of the
 *   path all have to survive the hop, and the `Host` header is rewritten to
 *   the upstream so a service that vhosts on it still answers.
 * - **A service with no detected URL gets an inspector with no port.** The
 *   status still reports `enabled: true`; there is simply nothing to proxy to
 *   yet, and the proxy starts later when a URL turns up. A port that answered
 *   `enabled: false` there would look correct until a slow-starting service
 *   was toggled before it printed its URL.
 * - **`enabled` is a form field, and only `"true"` and `"1"` mean true.** Not
 *   JSON, and not truthiness: `"yes"` is off.
 * - **A service that is not running is an error, not a no-op.**
 *
 * Usage:
 *   node --import tsx scripts/check-service-inspector-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
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

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-service-inspector-parity.ts [--dump] <candidate> [args...]",
  );
}

/**
 * A service that binds an ephemeral port and prints it in the shape the
 * manager watches stdout for, then answers every request by describing what it
 * received — which is how the gate sees that the proxy passed things through
 * rather than merely answering.
 */
const UPSTREAM = [
  "const http=require('http');",
  "const s=http.createServer((q,r)=>{",
  "r.writeHead(q.url==='/refuse'?503:200,{'content-type':'text/plain','x-from':'upstream'});",
  "r.end(JSON.stringify({path:q.url,method:q.method,host:q.headers.host}));",
  "});",
  "s.listen(0,'127.0.0.1',()=>console.log('ready on http://127.0.0.1:'+s.address().port+'/'));",
].join("");

/** A service that never prints a URL, so its inspector has nothing to proxy. */
const SILENT = "const t=setInterval(()=>{},1000);process.on('SIGTERM',()=>{clearInterval(t)});";

const renderConfig = () => ({
  version: 1,
  services: [
    { name: "web", command: `node -e "${UPSTREAM.replace(/"/g, '\\"')}"`, cwd: ".", env: {} },
    { name: "quiet", command: `node -e "${SILENT.replace(/"/g, '\\"')}"`, cwd: ".", env: {} },
  ],
  bundles: [],
  databases: [],
  gitRepositories: [],
});

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const credentials = new Map<string, string>();
/** Ports this run handed out, per runtime, so they can be masked by value. */
const ports = new Map<string, Set<number>>();
/**
 * The proxy port most recently reported, per runtime.
 *
 * Read from the toggle's own answer rather than from the service listing: the
 * listing carries no inspector at all, which is how the first version of this
 * gate came to drive its traffic at `undefined` and assert nothing.
 */
const proxyPort = new Map<string, number>();

function noteAndMask(runtime: Runtime, value: unknown): void {
  const inspector = (value as { status?: { inspector?: { port?: number; upstreamPort?: number } } })
    ?.status?.inspector;
  const seen = ports.get(runtime.label) ?? new Set<number>();
  for (const port of [inspector?.port, inspector?.upstreamPort]) {
    if (typeof port === "number") seen.add(port);
  }
  ports.set(runtime.label, seen);
  if (typeof inspector?.port === "number") proxyPort.set(runtime.label, inspector.port);
}

async function api(
  runtime: Runtime,
  method: string,
  path: string,
  body?: string,
): Promise<Answer> {
  const credential = credentials.get(runtime.label) ?? "";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* the SPA shell is HTML, compared as the text it was */
  }
  noteAndMask(runtime, parsed);
  return { status: response.status, body: parsed };
}

/** The proxy port the last toggle reported for this runtime. */
function inspectorPort(runtime: Runtime): number | undefined {
  return proxyPort.get(runtime.label);
}

function normalize(value: unknown, runtime: Runtime): unknown {
  let text = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .split(`127.0.0.1:${runtime.port}`)
    .join("<daemon>");
  // Every ephemeral port this run handed out, masked by its own value — the
  // numbers differ per runtime and carry no meaning beyond being the same one
  // twice.
  //
  // A port appears in two shapes and they are masked in this order: as a JSON
  // *number* (`"port":54321`), which has to become a quoted token or the text
  // stops being JSON, and then as text inside a URL string, where only the
  // digits are replaced.
  for (const port of ports.get(runtime.label) ?? []) {
    text = text.replace(new RegExp(`:\\s*${port}(?=[,}\\]])`, "g"), ':"<port>"');
    text = text.split(`:${port}`).join(":<port>");
  }
  return JSON.parse(
    text
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      // A duration is a measurement; only its presence is the contract.
      .replace(/"durationMs":\s*[\d.]+/g, '"durationMs":"<ms>"')
      .replace(/"detail":"[\d.]+ ms"/g, '"detail":"<ms> ms"')
      .replace(/"pid":\s*\d+/g, '"pid":"<pid>"')
      .replace(/"uptimeMs":\s*\d+/g, '"uptimeMs":"<ms>"')
      .replace(/"startedAt":"[^"]*"/g, '"startedAt":"<time>"'),
  );
}

const root = await mkdtemp(join(tmpdir(), "nmi-inspector-parity-"));
const harness = new RuntimeHarness(root);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one closure against both runtimes and diff what it returned.
 *
 * The whole closure is the recorded unit, not just the daemon call inside it.
 * Half the steps here reach past the daemon and speak to the *inspector proxy*
 * it opened, on a port it chose — which a recording cannot stand in for,
 * because in replay there is no reference to have opened one. What the
 * reference saw through that proxy is what was written down.
 */
async function both(name: string, run: (runtime: Runtime) => Promise<unknown>): Promise<void> {
  const answers = await Promise.all(
    runtimes.map(async (runtime) => {
      const observed = await harness.recorded(runtime, name, () => run(runtime));
      // A replayed observation never went through `api`, which is where the
      // ports in an answer are normally learned — and a port that was not
      // learned is a port that is not masked. Note them here too; on a live
      // observation this repeats what `api` already did, which a set and a
      // last-write map both survive.
      noteAndMask(runtime, (observed as { body?: unknown } | null)?.body ?? observed);
      return normalize(observed, runtime);
    }),
  );
  compare(name, answers[0], answers[1]);
}

const runtimes: Runtime[] = [];

try {
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(spec, renderConfig, () => []);
    await harness.startDaemon(runtime, {}, runtime.workspace);
    credentials.set(
      runtime.label,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
    runtimes.push(runtime);
  }

  /* ---- before anything is running ---- */
  await both("inspector/a-service-that-is-not-running", (r) =>
    api(r, "POST", "/api/services/web/inspector", "enabled=true"),
  );
  await both("inspector/a-service-nobody-registered", (r) =>
    api(r, "POST", "/api/services/nothing-here/inspector", "enabled=true"),
  );
  await both("inspector/wrong-method", (r) => api(r, "GET", "/api/services/web/inspector"));

  /* ---- with the service up ---- */
  await both("setup/start-the-service", (r) => api(r, "POST", "/api/services/web/start"));
  // The URL is learned from stdout, which arrives after the start call answers.
  await sleep(1500);

  await both("inspector/enable", (r) =>
    api(r, "POST", "/api/services/web/inspector", "enabled=true"),
  );
  await both("inspector/enable-again", (r) =>
    api(r, "POST", "/api/services/web/inspector", "enabled=true"),
  );

  /* ---- traffic through the proxy it just handed us ---- */
  await both("proxy/a-request-passes-through", async (r) => {
    const port = inspectorPort(r);
    if (!port) return { error: "no inspector port was reported" };
    const response = await fetch(`http://127.0.0.1:${port}/hello?x=1`);
    return {
      status: response.status,
      fromUpstream: response.headers.get("x-from"),
      body: await response.text(),
    };
  });
  await both("proxy/an-upstream-failure-passes-through", async (r) => {
    const port = inspectorPort(r);
    if (!port) return { error: "no inspector port was reported" };
    const response = await fetch(`http://127.0.0.1:${port}/refuse`);
    return { status: response.status, body: await response.text() };
  });
  await both("proxy/a-post-with-a-body", async (r) => {
    const port = inspectorPort(r);
    if (!port) return { error: "no inspector port was reported" };
    const response = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: "POST",
      body: "hello=world",
    });
    return { status: response.status, body: await response.text() };
  });

  await sleep(500);
  await both("timeline/the-requests-were-recorded", async (r) => {
    const answer = await api(r, "GET", "/api/timeline?limit=50");
    const entries = (answer.body as { timeline?: { kind: string }[] })?.timeline ?? [];
    const http = entries.filter((entry) => entry.kind === "service.http");
    if (http.length === 0) throw new Error("no service.http entries were recorded");
    return http;
  });

  /* ---- turning it off ---- */
  await both("inspector/disable", (r) =>
    api(r, "POST", "/api/services/web/inspector", "enabled=false"),
  );
  await both("proxy/the-port-is-gone", async (r) => {
    const port = inspectorPort(r);
    if (!port) return { error: "no port was ever reported" };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hello`);
      return { reached: true, status: response.status };
    } catch {
      // The message differs by Node build; that it refused is the contract.
      return { reached: false };
    }
  });

  /* ---- how `enabled` is read ---- */
  await both("enabled/the-string-one", (r) =>
    api(r, "POST", "/api/services/web/inspector", "enabled=1"),
  );
  await both("enabled/the-string-zero", (r) =>
    api(r, "POST", "/api/services/web/inspector", "enabled=0"),
  );
  await both("enabled/yes-is-not-true", (r) =>
    api(r, "POST", "/api/services/web/inspector", "enabled=yes"),
  );
  await both("enabled/an-absent-field", (r) =>
    api(r, "POST", "/api/services/web/inspector", ""),
  );
  await both("enabled/capitalised-true", (r) =>
    api(r, "POST", "/api/services/web/inspector", "enabled=True"),
  );
  await both("enabled/a-json-body-is-not-a-form", (r) =>
    api(r, "POST", "/api/services/web/inspector", '{"enabled":true}'),
  );

  /* ---- a service that never says where it is ---- */
  await both("setup/start-the-quiet-one", (r) => api(r, "POST", "/api/services/quiet/start"));
  await sleep(800);
  await both("inspector/a-service-with-no-url", (r) =>
    api(r, "POST", "/api/services/quiet/inspector", "enabled=true"),
  );
  await both("inspector/turning-that-one-off-again", (r) =>
    api(r, "POST", "/api/services/quiet/inspector", "enabled=false"),
  );

  /* ---- a name that had to be decoded ---- */
  await both("inspector/a-name-with-an-escape", (r) =>
    api(r, "POST", "/api/services/we%62/inspector", "enabled=false"),
  );
} finally {
  // Leave nothing listening: both daemons own real child processes here.
  for (const runtime of runtimes) {
    await api(runtime, "POST", "/api/services/web/stop").catch(() => undefined);
    await api(runtime, "POST", "/api/services/quiet/stop").catch(() => undefined);
  }
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.log(`\nservice-inspector parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log("\nservice-inspector parity: all cases match");
