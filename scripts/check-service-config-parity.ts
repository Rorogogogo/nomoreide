/**
 * Phase 6 parity gate for the service *config* surface: the endpoints that read
 * and edit a service's registration rather than run it.
 *
 *   GET    /api/services/graph
 *   GET    /api/services/:name/definition
 *   POST   /api/services/:name/project
 *   POST   /api/bundles
 *   POST   /api/bundles/:name/restart
 *   DELETE /api/services/:name
 *
 * Three things make this worth its own gate.
 *
 * **The graph is a pure function of config, and its interesting answers are the
 * broken ones.** A dependency on a service that is not registered is reported
 * as `missing` rather than dropped; a self-reference is dropped entirely; a
 * duplicate is collapsed. A cycle empties `order` and fills `cycles`, and the
 * cycle is reported as a *path*, which means the rotation it is written in is
 * observable. The fixture registers all four shapes.
 *
 * **These are writes, so the body is half the check.** Every case is followed
 * by a census of `config.json` in both homes, so a route that reported a
 * refusal and edited anyway — or edited more than it said — is caught.
 *
 * **All but `graph` are pattern routes**, so a wrong method is a 405 JSON
 * refusal here, not the shell's 404 HTML. Each one gets a case that proves it,
 * because the two are one router default apart.
 *
 * Usage:
 *   node --import tsx scripts/check-service-config-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-service-config-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly form?: string;
  /**
   * A divergence that is deliberate: assert each side against what it is
   * supposed to say instead of diffing them. Asserted rather than skipped, so
   * that closing the divergence fails this gate rather than passing quietly.
   */
  readonly divergent?: { readonly reference: unknown; readonly candidate: unknown };
}

/**
 * Stopping a name that was never registered.
 *
 * The reference stops by name without consulting config, so it answers
 * `stopped` and writes a runtime entry and a timeline event for what is almost
 * always a typo. The native daemon refuses instead. This is the same declared
 * divergence `scripts/check-mcp-runtime-parity.ts` records for
 * `nomoreide_stop_service`; it is repeated here because that gate covers the
 * tool and this one covers the HTTP route underneath it.
 */
const stopDivergence = {
  reference: { ok: true, status: { name: "ghost", state: "stopped" } },
  candidate: { ok: false, error: 'Service "ghost" is not registered.' },
} as const;

const encode = (value: string) => encodeURIComponent(value);

const steps: readonly Step[] = [
  // --- graph -----------------------------------------------------------------
  { name: "graph/read", method: "GET", path: "/api/services/graph" },
  // `graph` is a single segment, so a wrong method does not fall through to the
  // shell — it falls through to the `/api/services/:name` pattern route, which
  // checks the method itself. Hence a 405, and hence a DELETE that is not a
  // refusal at all but an attempt to remove a service called "graph".
  { name: "graph/wrong-method", method: "POST", path: "/api/services/graph" },
  { name: "graph/delete", method: "DELETE", path: "/api/services/graph" },

  // --- definition ------------------------------------------------------------
  { name: "definition/known", method: "GET", path: "/api/services/api/definition" },
  { name: "definition/with-every-field", method: "GET", path: "/api/services/full/definition" },
  { name: "definition/unknown", method: "GET", path: "/api/services/ghost/definition" },
  // The name is decoded, so a service whose name needs encoding is reachable.
  { name: "definition/encoded-name", method: "GET", path: `/api/services/${encode("web ui")}/definition` },
  { name: "definition/blank-name", method: "GET", path: `/api/services/${encode("   ")}/definition` },
  // A pattern route: this one really is a 405.
  { name: "definition/wrong-method", method: "POST", path: "/api/services/api/definition" },

  // --- project ---------------------------------------------------------------
  { name: "project/assign", method: "POST", path: "/api/services/api/project", form: "projectPath=%2Ftmp%2Fproj" },
  { name: "project/reassign", method: "POST", path: "/api/services/api/project", form: "projectPath=%2Ftmp%2Fother" },
  // Blank and absent both mean "clear the assignment", not "store empty".
  { name: "project/clear-with-blank", method: "POST", path: "/api/services/api/project", form: "projectPath=%20%20" },
  { name: "project/clear-with-nothing", method: "POST", path: "/api/services/worker/project", form: "" },
  { name: "project/unknown-service", method: "POST", path: "/api/services/ghost/project", form: "projectPath=%2Ftmp%2Fproj" },
  { name: "project/blank-service-name", method: "POST", path: `/api/services/${encode("   ")}/project`, form: "projectPath=%2Ftmp%2Fproj" },
  { name: "project/wrong-method", method: "GET", path: "/api/services/api/project" },

  // --- bundles ---------------------------------------------------------------
  { name: "bundles/register", method: "POST", path: "/api/bundles", form: "name=fresh&services=api%2Cworker" },
  // Dragging the last member out of a group leaves a bundle with no services.
  { name: "bundles/register-empty", method: "POST", path: "/api/bundles", form: "name=hollow&services=" },
  { name: "bundles/blank-members-are-dropped", method: "POST", path: "/api/bundles", form: "name=trimmed&services=api%2C%2C%20%2Cworker" },
  // A rename: the old name goes, the new one arrives, in one write.
  { name: "bundles/rename", method: "POST", path: "/api/bundles", form: "name=renamed&services=api&originalName=fresh" },
  { name: "bundles/rename-from-nothing", method: "POST", path: "/api/bundles", form: "name=late&services=api&originalName=never-existed" },
  { name: "bundles/members-need-not-exist", method: "POST", path: "/api/bundles", form: "name=dangling&services=ghost" },
  { name: "bundles/missing-name", method: "POST", path: "/api/bundles", form: "services=api" },
  { name: "bundles/blank-name", method: "POST", path: "/api/bundles", form: "name=%20%20&services=api" },
  // `/api/bundles` is an exact route with no pattern route behind it, so this
  // one really is the shell's 404 HTML.
  { name: "bundles/wrong-method", method: "GET", path: "/api/bundles" },

  // --- bundle restart --------------------------------------------------------
  { name: "bundle-restart/unknown", method: "POST", path: "/api/bundles/ghost/restart" },
  { name: "bundle-restart/empty-bundle", method: "POST", path: "/api/bundles/hollow/restart" },
  { name: "bundle-restart/wrong-method", method: "GET", path: "/api/bundles/hollow/restart" },
  // start and stop share the dispatcher with restart, so they are checked here
  // too: whatever status an unregistered bundle gets, all three must agree.
  { name: "bundle-start/unknown", method: "POST", path: "/api/bundles/ghost/start" },
  { name: "bundle-stop/unknown", method: "POST", path: "/api/bundles/ghost/stop" },
  // The same envelope, reached through a service rather than a bundle.
  { name: "service-start/unknown", method: "POST", path: "/api/services/ghost/start" },
  { name: "service-stop/unknown", method: "POST", path: "/api/services/ghost/stop", divergent: stopDivergence },

  // --- delete ----------------------------------------------------------------
  { name: "delete/unknown", method: "DELETE", path: "/api/services/ghost" },
  { name: "delete/blank-name", method: "DELETE", path: `/api/services/${encode("   ")}` },
  { name: "delete/wrong-method", method: "PUT", path: "/api/services/worker" },
  // Deleting a member also prunes it from every bundle that named it.
  { name: "delete/a-bundle-member", method: "DELETE", path: "/api/services/worker" },
  { name: "delete/the-same-service-again", method: "DELETE", path: "/api/services/worker" },
  { name: "delete/an-encoded-name", method: "DELETE", path: `/api/services/${encode("web ui")}` },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly cacheControl: string | null;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  if (step.form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
    body: step.form,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: parsed,
  };
}

function erase(value: string, runtime: Runtime): string {
  return value.split(`/private${runtime.home}`).join("<home>").split(runtime.home).join("<home>");
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  return { ...answer, body: JSON.parse(erase(JSON.stringify(answer.body), runtime)) };
}

/** The config each runtime is left holding. */
async function census(runtime: Runtime): Promise<unknown> {
  const raw = await readFile(join(runtime.home, ".config", "nomoreide", "config.json"), "utf8");
  return JSON.parse(erase(raw, runtime));
}

const root = await mkdtemp(join(tmpdir(), "nmi-service-config-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      (partial) => ({
        version: 1,
        services: [
          // A plain leaf.
          { name: "db", command: "sleep 100", cwd: partial.workspace },
          // Depends on the leaf, plus a dep that is not registered (missing),
          // a self-reference (dropped), and a duplicate (collapsed).
          {
            name: "api",
            command: "sleep 100",
            cwd: partial.workspace,
            port: 4001,
            dependsOn: ["db", "db", "api", "nowhere"],
          },
          { name: "worker", command: "sleep 100", cwd: partial.workspace, dependsOn: ["api"] },
          // A two-node cycle, which empties `order` for the whole graph.
          { name: "left", command: "sleep 100", cwd: partial.workspace, dependsOn: ["right"] },
          { name: "right", command: "sleep 100", cwd: partial.workspace, dependsOn: ["left"] },
          // A name that has to be percent-encoded to be addressable.
          { name: "web ui", command: "sleep 100", cwd: partial.workspace },
          // Every optional field set, so `definition` is checked on a whole
          // record rather than on the three fields a minimal service has.
          {
            name: "full",
            kind: "local",
            command: "sleep 100",
            args: ["--flag", "value"],
            cwd: partial.workspace,
            port: 4002,
            description: "everything set",
            projectPath: "/tmp/assigned",
            env: { TOKEN: "hunter2", PLAIN: "value" },
            dependsOn: ["db"],
          },
        ],
        bundles: [
          { name: "stack", services: ["api", "worker"] },
          { name: "solo", services: ["worker"] },
        ],
        databases: [],
        gitRepositories: [],
      }),
      () => [],
    );
    await harness.startDaemon(runtime, {});
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    const answers = {
      reference: await send(reference, step),
      candidate: await send(candidate, step),
    };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(answers.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(answers.candidate, { depth: null })}`);
    }
    try {
      if (step.divergent) {
        assert.deepStrictEqual(
          normalize(answers.reference, reference).body,
          step.divergent.reference,
          "the reference side of a declared divergence changed",
        );
        assert.deepStrictEqual(
          normalize(answers.candidate, candidate).body,
          step.divergent.candidate,
          "the candidate side of a declared divergence changed",
        );
      } else {
        assert.deepStrictEqual(
          normalize(answers.candidate, candidate),
          normalize(answers.reference, reference),
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

  const both = { reference: await census(reference), candidate: await census(candidate) };
  try {
    assert.deepStrictEqual(both.candidate, both.reference);
    console.log("ok   config/on-disk");
  } catch (error) {
    failures += 1;
    console.log("FAIL config/on-disk");
    console.log(`  reference: ${inspect(both.reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(both.candidate, { depth: null })}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

const total = steps.length + 1;
if (failures > 0) {
  console.log(`\nservice-config parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nservice-config parity: ${total} cases match`);
