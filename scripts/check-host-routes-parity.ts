/**
 * Parity gate for the host provider's HTTP surface:
 *
 *   GET            /api/hosts
 *   GET            /api/hosts/:provider/status
 *   POST|DELETE    /api/hosts/:provider/connect
 *   GET            /api/hosts/:provider/instances
 *   GET            /api/hosts/:provider/instances/:instance
 *   POST           /api/hosts/:provider/instances/:instance/:action
 *
 * Distinct from `check-host-parity.ts`, which drives the *provider layer*
 * through a probe binary because these routes did not exist when it was
 * written. That gate still answers "does the Vultr client behave the same";
 * this one answers "does the daemon". They are different questions, and the
 * second is where the status codes, the verb handling and the persisted config
 * live — none of which a probe can see.
 *
 * The vendor responses come from `test/fixtures/host-parity-v1.json`, so the
 * two gates cannot drift about what Vultr said.
 *
 * What the cases are watching for:
 *
 * **The failure statuses are per-route and none of them is a house style.**
 * `status` answers 200 for a connected provider that refused and **404** for an
 * id nobody claims — where the *deploy* side's `connect` answers 400 for the
 * same mistake, because they are two `try` blocks and not one shared rule.
 * `connect` answers 400 for everything, the instance reads answer 500 for
 * everything, and the action route answers 404 for an undeclared name and 400
 * for the rest.
 *
 * **An undeclared action never becomes a request.** Vultr serves `destroy` and
 * `reinstall` endpoints this codebase deliberately does not implement, so the
 * recorded requests are what prove a refused action reached no vendor at all —
 * an answer alone would look identical if it had fired and failed.
 *
 * **The action name is never percent-decoded**, so `reb%6fot` is a name no
 * manifest declares rather than a reboot.
 *
 * **A `cli` connection stores no token.** Vultr's ambient source is an exported
 * `VULTR_API_KEY` rather than a session file, and what makes it `cli` is the
 * policy: it is never written to config. The persisted config is compared after
 * every write, because a runtime that stored the key would answer
 * `{ ok: true }` just the same.
 *
 * That claim is checked as an **end state**, and deliberately so: two layers
 * enforce it — the route sets no token for a `cli` source, and the config store
 * strips one from any `cli` connection it is handed — so breaking either alone
 * changes nothing observable, and only breaking both puts a key on disk.
 * Verified by seeding exactly that pair, which this gate does catch. A gate
 * that pinned one of the two layers instead would fail on a refactor that moved
 * the enforcement while keeping the guarantee.
 *
 * **Vultr's `cliSession` carries no scope**, unlike Vercel's — an API key
 * addresses one account and there is no team to inherit — so a `cli` connection
 * must persist with no `scopeId` at all rather than with an empty one.
 *
 * Usage:
 *   node --import tsx scripts/check-host-routes-parity.ts [--dump] <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-host-routes-parity.ts [--dump] <candidate> [args...]",
  );
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/host-parity-v1.json"), "utf8"),
) as { fixtureVersion: number; api: StubRoute[] };
if (fixture.fixtureVersion !== 2) {
  throw new Error(`Unsupported host parity fixture version ${fixture.fixtureVersion}`);
}

/**
 * The two the shared fixture has no reason to carry: an action on an instance
 * the fixture does not otherwise power, and the vendor refusing one.
 */
const EXTRA: StubRoute[] = [
  { method: "POST", path: "/instances/inst%20space/reboot", body: {} },
  {
    method: "POST",
    path: "/instances/inst_missing/halt",
    status: 404,
    body: { error: "Instance not found" },
  },
];

const API: StubRoute[] = [...fixture.api, ...EXTRA];

/** The same account, refusing the credential outright. */
const AUTH_FAILURE_API: StubRoute[] = [
  { method: "GET", path: "/account", status: 401, body: { error: "Invalid API key" } },
  {
    method: "GET",
    path: "/instances?per_page=500",
    status: 401,
    body: { error: "Invalid API key" },
  },
];

/** The vendor down rather than refusing — a different status on the panel. */
const OUTAGE_API: StubRoute[] = [
  { method: "GET", path: "/account", status: 503, body: { error: "Vultr is unavailable" } },
];

/** Every secret the fixtures hold. None may appear in an answer. */
const SECRETS = ["vultr-test-token", "pasted-key", "ambient-key"];

interface Step {
  name: string;
  path: string;
  method?: string;
  /** Raw request body, sent verbatim. */
  body?: string;
  /** Defaults to the form encoding `connect` uses. */
  contentType?: string;
  /** Also compare the persisted config after this step. */
  config?: boolean;
}

const CONNECTED_STEPS: Step[] = [
  { name: "registry/list", path: "/api/hosts" },
  { name: "registry/a-post-is-still-a-read", path: "/api/hosts", method: "POST" },

  { name: "status/connected", path: "/api/hosts/vultr/status" },
  // Guards no verb at all, unlike the instance reads below it.
  { name: "status/a-post-is-still-a-read", path: "/api/hosts/vultr/status", method: "POST" },
  // A 404 here, where the deploy side answers 400 for the same mistake.
  { name: "status/an-unknown-provider", path: "/api/hosts/nowhere/status" },
  { name: "status/a-deploy-provider-is-not-a-host", path: "/api/hosts/vercel/status" },

  { name: "instances/all", path: "/api/hosts/vultr/instances" },
  {
    name: "instances/a-post-is-not-a-read",
    path: "/api/hosts/vultr/instances",
    method: "POST",
  },
  { name: "instances/an-unknown-provider", path: "/api/hosts/nowhere/instances" },

  { name: "instance/one", path: "/api/hosts/vultr/instances/inst_running" },
  { name: "instance/an-encoded-id", path: "/api/hosts/vultr/instances/inst%20space" },
  { name: "instance/an-id-that-changes-the-url", path: "/api/hosts/vultr/instances/inst%231" },
  { name: "instance/a-broken-escape", path: "/api/hosts/vultr/instances/inst%zz" },
  { name: "instance/missing", path: "/api/hosts/vultr/instances/inst_missing" },
  {
    name: "instance/no-message-in-the-body",
    path: "/api/hosts/vultr/instances/inst_unhelpful",
  },
  {
    name: "instance/a-delete-is-not-a-read",
    path: "/api/hosts/vultr/instances/inst_running",
    method: "DELETE",
  },
  { name: "instance/an-unknown-provider", path: "/api/hosts/nowhere/instances/inst_running" },

  {
    name: "action/reboot",
    path: "/api/hosts/vultr/instances/inst_running/reboot",
    method: "POST",
  },
  { name: "action/halt", path: "/api/hosts/vultr/instances/inst_running/halt", method: "POST" },
  { name: "action/start", path: "/api/hosts/vultr/instances/inst_running/start", method: "POST" },
  {
    name: "action/an-encoded-instance-id",
    path: "/api/hosts/vultr/instances/inst%20space/reboot",
    method: "POST",
  },
  {
    name: "action/a-broken-escape",
    path: "/api/hosts/vultr/instances/inst%zz/reboot",
    method: "POST",
  },
  // The vendor refusing a power operation, which is a 400 rather than the 500
  // the reads answer.
  {
    name: "action/the-vendor-refused",
    path: "/api/hosts/vultr/instances/inst_missing/halt",
    method: "POST",
  },
  // Both of these are real Vultr endpoints this codebase does not implement.
  // The recorded requests are what prove neither reached the vendor.
  {
    name: "action/destroy-is-not-an-action",
    path: "/api/hosts/vultr/instances/inst_running/destroy",
    method: "POST",
  },
  {
    name: "action/reinstall-is-not-an-action",
    path: "/api/hosts/vultr/instances/inst_running/reinstall",
    method: "POST",
  },
  // The name is never decoded, so this is an unknown action rather than a
  // reboot.
  {
    name: "action/an-escaped-action-name",
    path: "/api/hosts/vultr/instances/inst_running/reb%6fot",
    method: "POST",
  },
  {
    name: "action/a-get-is-not-a-write",
    path: "/api/hosts/vultr/instances/inst_running/reboot",
    method: "GET",
  },
  {
    name: "action/an-unknown-provider",
    path: "/api/hosts/nowhere/instances/inst_running/reboot",
    method: "POST",
  },
  {
    name: "action/a-get-on-an-unknown-provider",
    path: "/api/hosts/nowhere/instances/inst_running/reboot",
    method: "GET",
  },
];

/** Writing and forgetting a credential, with the stored config read each time. */
const CONNECT_STEPS: Step[] = [
  { name: "connect/nothing-stored-yet", path: "/api/hosts/vultr/status" },
  {
    name: "connect/a-pasted-key",
    path: "/api/hosts/vultr/connect",
    method: "POST",
    body: "token=pasted-key",
    config: true,
  },
  { name: "connect/status-after-pasting", path: "/api/hosts/vultr/status" },
  // Trimmed to nothing is no token.
  {
    name: "connect/a-key-of-spaces",
    path: "/api/hosts/vultr/connect",
    method: "POST",
    body: "token=%20%20%20",
    config: true,
  },
  {
    name: "connect/no-token-at-all",
    path: "/api/hosts/vultr/connect",
    method: "POST",
    body: "",
    config: true,
  },
  // The ambient source: an exported VULTR_API_KEY, which is never written to
  // config — and which carries no scope, unlike a Vercel CLI session.
  {
    name: "connect/the-ambient-key",
    path: "/api/hosts/vultr/connect",
    method: "POST",
    body: "source=cli",
    config: true,
  },
  { name: "connect/status-on-the-ambient-key", path: "/api/hosts/vultr/status" },
  {
    name: "connect/disconnect",
    path: "/api/hosts/vultr/connect",
    method: "DELETE",
    config: true,
  },
  { name: "connect/status-after-disconnect", path: "/api/hosts/vultr/status" },
  {
    name: "connect/a-put-is-neither-verb",
    path: "/api/hosts/vultr/connect",
    method: "PUT",
  },
  {
    name: "connect/an-unknown-provider",
    path: "/api/hosts/nowhere/connect",
    method: "POST",
    body: "token=pasted-key",
  },
  // The lookup opens the `try` and the verb check is inside it, so this names
  // the provider rather than the method.
  {
    name: "connect/a-get-on-an-unknown-provider",
    path: "/api/hosts/nowhere/connect",
    method: "GET",
  },
];

/**
 * The SSH-target cache, which is invisible in an answer and plain in the
 * recorded requests.
 *
 * A host provider's machines also reach the user through `/api/servers`, which
 * caches them for 30 seconds. Every write here has to drop that cache, or a
 * machine someone just rebooted keeps reporting its old state on the servers
 * list for the next half-minute — and the vendor is not the one saying so.
 *
 * The stub answers identically every time, so the *answers* here prove nothing.
 * What proves it is whether the second `/api/servers` reached the vendor at all:
 * a cache that was dropped re-fetches, and one that was not is served from
 * memory and makes no request.
 */
const CACHE_STEPS: Step[] = [
  { name: "cache/servers-warms-it", path: "/api/servers" },
  // Still warm: no vendor request, which is what makes the two below mean
  // something.
  { name: "cache/servers-again-is-cached", path: "/api/servers" },
  {
    name: "cache/a-reboot-drops-it",
    path: "/api/hosts/vultr/instances/inst_running/reboot",
    method: "POST",
  },
  { name: "cache/servers-refetches-after-a-reboot", path: "/api/servers" },
  // A credential change means a different set of machines entirely.
  {
    name: "cache/a-disconnect-drops-it-too",
    path: "/api/hosts/vultr/connect",
    method: "DELETE",
  },
  { name: "cache/servers-refetches-after-a-disconnect", path: "/api/servers" },
];

/** No credential at all — the state most users are in. */
const DISCONNECTED_STEPS: Step[] = [
  { name: "disconnected/status", path: "/api/hosts/vultr/status" },
  { name: "disconnected/instances", path: "/api/hosts/vultr/instances" },
  { name: "disconnected/instance", path: "/api/hosts/vultr/instances/inst_running" },
  {
    name: "disconnected/action",
    path: "/api/hosts/vultr/instances/inst_running/reboot",
    method: "POST",
  },
];

/** The vendor rejecting the credential, and the vendor being down. */
const REFUSED_STEPS: Step[] = [
  { name: "refused/status-is-an-auth-error", path: "/api/hosts/vultr/status" },
  { name: "refused/instances", path: "/api/hosts/vultr/instances" },
];

const OUTAGE_STEPS: Step[] = [
  { name: "outage/status-is-a-connection-error", path: "/api/hosts/vultr/status" },
];

const root = join(process.env.TMPDIR ?? "/tmp", `nomoreide-host-routes-${process.pid}`);
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
    if (text.includes(secret)) {
      throw new Error(`${runtime.label} put a stored key in the answer to ${step.name}`);
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

/** The stored config, with the runtime's own home replaced. */
async function persistedConfig(runtime: Runtime): Promise<unknown> {
  const raw = await readFile(
    join(runtime.home, ".config", "nomoreide", "config.json"),
    "utf8",
  ).catch(() => "");
  if (!raw) return null;
  return JSON.parse(raw.split(runtime.home).join("{{home}}"));
}

interface WalkOptions {
  label: string;
  plan: Step[];
  /** A stored key, or none at all. */
  connected: boolean;
  api?: StubRoute[];
  /** Export VULTR_API_KEY, so the ambient source is available. */
  ambient?: boolean;
}

async function walk({
  label,
  plan,
  connected,
  api = API,
  ambient = false,
}: WalkOptions): Promise<void> {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      { ...spec, label: `${spec.label}-${label}` },
      () => ({
        version: 1,
        connections: connected ? { vultr: { source: "stored", token: "vultr-test-token" } } : {},
        gitRepositories: [],
        services: [],
        bundles: [],
        databases: [],
        sshServers: [],
      }),
      () => [],
    );
    const stub = await startApiStub(api);
    stubs.push(stub);
    await harness.startDaemon(runtime, {
      NOMOREIDE_VULTR_API_BASE: stub.base,
      // Set explicitly either way: a key exported on the machine running this
      // would otherwise make the ambient source available where a case expects
      // it absent, and the two runtimes inherit the same environment so both
      // would agree while testing something else.
      VULTR_API_KEY: ambient ? "ambient-key" : "",
      VULTR_API_TOKEN: "",
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
    // Wrapped as one unit rather than three: the answer, what the daemon
    // asked Vultr, and what it persisted are the comparison, and in replay
    // the reference produced all three at record time or none of them now.
    const observe = (runtime: Runtime, stub: ApiStub) =>
      harness.recorded(runtime, step.name, async () => ({
        answer: await send(runtime, step),
        requests: stub.take(),
        ...(step.config ? { config: await persistedConfig(runtime) } : {}),
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
  await walk({ label: "connected", plan: CONNECTED_STEPS, connected: true });
  await walk({ label: "connect", plan: CONNECT_STEPS, connected: false, ambient: true });
  await walk({ label: "cache", plan: CACHE_STEPS, connected: true });
  await walk({ label: "disconnected", plan: DISCONNECTED_STEPS, connected: false });
  await walk({
    label: "refused",
    plan: REFUSED_STEPS,
    connected: true,
    api: AUTH_FAILURE_API,
  });
  await walk({ label: "outage", plan: OUTAGE_STEPS, connected: true, api: OUTAGE_API });
} finally {
  await harness.shutdown();
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await rm(root, { recursive: true, force: true });
}

const total = [
  CONNECTED_STEPS,
  CONNECT_STEPS,
  CACHE_STEPS,
  DISCONNECTED_STEPS,
  REFUSED_STEPS,
  OUTAGE_STEPS,
].reduce((sum, plan) => sum + plan.length, 0);
if (failures > 0) {
  console.log(`\nhost-routes parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nhost-routes parity: ${total} cases match`);
