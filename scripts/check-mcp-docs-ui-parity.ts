/**
 * Phase 4 documentation-and-UI parity gate.
 *
 * Three tools that need no fixture repository and no database: the docs table,
 * and the pair that decides whether a daemon exists at all. They are gated
 * together because they are the whole of the manifest's `documentation-ui`
 * domain, not because they share machinery.
 *
 * The docs half is prose, compared verbatim — every topic, the index, and the
 * three ways a topic can be rejected. The one thing that is not a literal is
 * the version in the overview: the reference used to name a hardcoded one that
 * had drifted four releases behind the package it described, so both runtimes
 * now interpolate their own, and this gate compares them. That makes a version
 * skew between `package.json` and the Cargo workspace a gate failure, which is
 * the point — `scripts/sync-version.mjs` is what keeps them equal.
 *
 * The UI half drives each runtime's own daemon through four of the five states
 * `nomoreide_open_ui` distinguishes. The fifth is recorded here rather than
 * gated:
 *
 *  - `started`. Reaching it means no daemon is running, and the reference is
 *    launched from `src/index.ts`, which cannot spawn one — it looks for a
 *    built `src/index.js` beside itself and refuses. The native binary always
 *    can, so the two runtimes disagree about a state only one of them can be
 *    in. Everything up to the spawn is shared and gated; the spawn itself is
 *    covered by the native runtime's own tests.
 *
 * Nothing here reads either implementation.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-docs-ui-parity.ts <candidate> [args...]
 *   ... --dump   print both payloads per step
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  delay,
  referenceSpec,
  RuntimeHarness,
  toolPayload,
  type Runtime,
} from "../test/support/runtime-parity.js";

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const candidateArgv = argv.filter((argument) => argument !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-docs-ui-parity.ts [--dump] <candidate-command> [candidate-args...]",
  );
}

/** The topic ids the tool's own index lists, in the order it lists them. */
const TOPICS = [
  "overview",
  "setup",
  "mcp",
  "cli",
  "dashboard",
  "tools",
  "vercel",
  "agent-environments",
  "safety",
  "troubleshooting",
  "architecture",
  "ai-agent",
] as const;

const EMPTY_CONFIG = {
  version: 1,
  services: [],
  bundles: [],
  gitRepositories: [],
};

const root = await mkdtemp(join(tmpdir(), "nomoreide-docs-ui-parity-"));
const harness = new RuntimeHarness(root);
let foreign: Server | undefined;
let compared = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(candidateArgv)]) {
    runtimes.push(await harness.provision(spec, () => EMPTY_CONFIG, () => []));
  }

  // The docs table answers without a daemon, so this half runs before one
  // exists — which is also the only proof that it needs none.
  for (const step of docsPlan()) {
    await compare(runtimes, step.name, (runtime) =>
      harness.call(runtime, "nomoreide_docs", step.args),
    );
  }

  for (const runtime of runtimes) {
    await harness.startDaemon(runtime);
  }

  await compare(runtimes, "ui-open-reports-the-recorded-daemon", (runtime) =>
    harness.call(runtime, "nomoreide_open_ui"),
  );

  // A daemon nothing recorded is still a daemon. Removing the state file — and
  // putting it back — is the only way to reach that from outside, because the
  // alternative is a daemon started by a session that is not this one.
  const recorded = await Promise.all(runtimes.map((runtime) => takeState(runtime)));
  await compare(runtimes, "ui-open-adopts-a-daemon-with-no-state-file", (runtime) =>
    harness.call(runtime, "nomoreide_open_ui"),
  );
  await Promise.all(runtimes.map((runtime, index) => restoreState(runtime, recorded[index])));

  // Something else on the port, and a home that has never seen a daemon, so
  // discovery has nothing but the port to go on.
  foreign = await startForeignServer();
  const foreignPort = (foreign.address() as { port: number }).port;
  const strangerHome = join(root, "stranger");
  await mkdir(join(strangerHome, ".config", "nomoreide"), { recursive: true });
  await compare(runtimes, "ui-open-refuses-a-foreign-port", (runtime) =>
    harness.call(runtime, "nomoreide_open_ui", {}, {
      HOME: strangerHome,
      XDG_CONFIG_HOME: join(strangerHome, ".config"),
      NOMOREIDE_DAEMON_PORT: String(foreignPort),
    }),
  );

  // A port that is not ours is not ours to stop. This is the close half of the
  // step above, and without it a runtime that refused a foreign port here —
  // rather than reporting nothing to stop — would look identical.
  await compare(runtimes, "ui-close-ignores-a-foreign-port", (runtime) =>
    harness.call(runtime, "nomoreide_close_ui", {}, {
      HOME: strangerHome,
      XDG_CONFIG_HOME: join(strangerHome, ".config"),
      NOMOREIDE_DAEMON_PORT: String(foreignPort),
    }),
  );

  // Last, because it takes the daemon with it: everything above needs one.
  await compare(runtimes, "ui-close-stops-the-daemon", (runtime) =>
    harness.call(runtime, "nomoreide_close_ui"),
  );
  // In record/replay the reference's public port belongs to the harness proxy,
  // not the daemon the tool just stopped. The proxy intentionally survives
  // until harness shutdown, so only the real candidate port can close here.
  await Promise.all(
    runtimes
      .filter((runtime) => harness.mode === "live" || runtime.label === "candidate")
      .map((runtime) => waitForPortToClose(runtime)),
  );
  await compare(runtimes, "ui-close-on-nothing-running", (runtime) =>
    harness.call(runtime, "nomoreide_close_ui"),
  );

  // The one state the reference cannot reach, so it is checked rather than
  // compared: with nothing running and nothing recorded, the native binary
  // spawns a daemon and reports it. Asserted against the shape the other four
  // states were diffed into, so a `started` that reported something else — or
  // that left no daemon behind — still fails here.
  await checkTheSpawnTheReferenceCannotDo(runtimes[1]);

  console.log(
    `MCP docs and UI parity passed (${compared} steps, plus the candidate-only spawn check).`,
  );
} finally {
  foreign?.closeAllConnections?.();
  foreign?.close();
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

interface DocsStep {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** The index, every topic, and the three shapes a topic can be rejected as. */
function docsPlan(): DocsStep[] {
  return [
    { name: "docs-index", args: {} },
    ...TOPICS.map((topic) => ({ name: `docs-${topic}`, args: { topic } })),
    { name: "docs-rejects-an-unknown-topic", args: { topic: "nope" } },
    { name: "docs-rejects-an-empty-topic", args: { topic: "" } },
    { name: "docs-rejects-a-non-string-topic", args: { topic: 5 } },
    // Unknown keys are stripped rather than rejected, so this is the index.
    { name: "docs-ignores-an-unknown-argument", args: { unexpected: true } },
  ];
}

/**
 * `nomoreide_open_ui` with no daemon and no state file. The reference is
 * launched from `src/index.ts` and refuses to spawn — it looks for a built
 * `src/index.js` beside itself — so there is nothing to diff against and this
 * asserts the shape instead. It runs last because it leaves a daemon of its
 * own, which it then takes back down.
 */
async function checkTheSpawnTheReferenceCannotDo(candidate: Runtime): Promise<void> {
  await rm(join(candidate.home, ".nomoreide", "daemon.json"), { force: true });
  const opened = normalize(toolPayload(await harness.call(candidate, "nomoreide_open_ui"))) as {
    isError?: boolean;
    payload?: Record<string, unknown>;
  };
  try {
    assert.deepStrictEqual(opened, {
      isError: false,
      payload: {
        status: "started",
        url: "http://127.0.0.1:<port>",
        port: "<port>",
        pid: "<pid>",
      },
    });
  } catch (error) {
    console.error("\nThe candidate did not spawn a daemon it could report.");
    console.error(inspect(opened, { depth: null }));
    throw error;
  }
  const closed = toolPayload(await harness.call(candidate, "nomoreide_close_ui")) as {
    payload?: { status?: string };
  };
  assert.equal(closed.payload?.status, "stopping", "the spawned daemon refused to stop");
  await waitForPortToClose(candidate);
}

async function compare(
  runtimes: readonly Runtime[],
  name: string,
  call: (runtime: Runtime) => Promise<unknown>,
): Promise<void> {
  const observed = await Promise.all(
    runtimes.map(async (runtime) => normalize(toolPayload(await call(runtime)))),
  );
  if (dump) {
    for (const [index, payload] of observed.entries()) {
      console.log(`\n--- ${name} [${runtimes[index].label}]`);
      console.log(inspect(payload, { depth: null }));
    }
  }
  try {
    assert.deepStrictEqual(observed[1], observed[0]);
  } catch (error) {
    console.error(`\nDocs/UI parity failed at step "${name}".`);
    console.error(`reference: ${inspect(observed[0], { depth: null })}`);
    console.error(`candidate: ${inspect(observed[1], { depth: null })}`);
    throw error;
  }
  compared += 1;
}

/**
 * Erase only the port each runtime was given and the pid its daemon happens to
 * have. Both are host detail; every other field, the refusal sentences
 * included, is compared as reported.
 */
function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\b127\.0\.0\.1:\d+/g, "127.0.0.1:<port>").replace(/\bPort \d+\b/g, "Port <port>");
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) =>
        key === "pid" || key === "port" ? [key, `<${key}>`] : [key, normalize(child)],
      ),
    );
  }
  return value;
}

/** Read a runtime's daemon state file and remove it, returning what it held. */
async function takeState(runtime: Runtime): Promise<string> {
  const path = join(runtime.home, ".nomoreide", "daemon.json");
  const contents = await readFile(path, "utf8");
  await rm(path, { force: true });
  return contents;
}

async function restoreState(runtime: Runtime, contents: string): Promise<void> {
  await writeFile(join(runtime.home, ".nomoreide", "daemon.json"), contents);
}

/** An HTTP server that answers, but not as a NoMoreIDE daemon. */
async function startForeignServer(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, app: "not-nomoreide" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/** A shutdown answers before it happens, so the next step has to wait for it. */
async function waitForPortToClose(runtime: Runtime): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${runtime.port}/api/health`);
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error(`The ${runtime.label} daemon never released port ${runtime.port}`);
}
