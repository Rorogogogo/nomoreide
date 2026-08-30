/**
 * Phase 4 host-provider parity gate.
 *
 * Vultr is gated here at the **provider layer**, not over HTTP: no MCP tool
 * reaches it, so this follows the pattern `check-git-actions-parity.ts` set for
 * exactly that case — run the TypeScript provider and the Rust one against
 * their own identical loopback stand-ins for the vendor, and diff what each
 * returns.
 *
 * `/api/hosts/*` is now served natively too, and
 * `check-host-routes-parity.ts` gates that surface over HTTP. The two ask
 * different questions and both are worth asking: this one is "does the Vultr
 * client behave the same", and that one is "does the daemon" — status codes,
 * verb handling and persisted config, none of which a probe can see. They share
 * `test/fixtures/host-parity-v1.json`, so they cannot drift about what Vultr
 * said.
 *
 * Two things are compared per step: what the operation reported, and every
 * request it made to the vendor to get there — method, path and query, headers,
 * and body. A runtime that built a query differently would otherwise only be
 * visible as a 404.
 *
 * The Rust side is reached through `examples/vultr-probe.rs`.
 *
 * The plan runs twice. The main pass is *connected*; the second plants no
 * credential, because "not connected" is the state most users are in and its
 * message is the one they read.
 *
 * Nothing here reads either implementation.
 * `test/fixtures/host-parity-v1.json` holds the canned vendor responses and the
 * ordered plan; both sides see the same ones.
 *
 * Usage:
 *   node --import tsx scripts/check-host-parity.ts [--dump] [<probe-binary>]
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { ConfigStore } from "../src/core/config-store.js";
import {
  providerCliStatus,
  publicProviderConnection,
} from "../src/core/providers/credentials.js";
import { type ApiStub, type StubRoute, startApiStub } from "./support/http-api-stub.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolvePath(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const probeBinary =
  argv.find((argument) => !argument.startsWith("--")) ??
  join(repositoryRoot, "target/debug/examples/vultr-probe");

interface Step {
  id: string;
  /** `status`, `instances`, `instance <id>`, or `action <name> <instance>`. */
  op: "status" | "instances" | "instance" | "action";
  args?: string[];
}

interface Fixture {
  fixtureVersion: 2;
  config: Record<string, unknown>;
  api: StubRoute[];
  plan: Step[];
  disconnected: { config: Record<string, unknown>; plan: Step[] };
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/host-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 2) {
  throw new Error(`Unsupported host parity fixture version ${fixture.fixtureVersion}`);
}

const root = await mkdtemp(join(tmpdir(), "nomoreide-host-parity-"));

/**
 * One stub, started *before* the provider is imported.
 *
 * The manifest — and with it the egress allowlist — is a module-level constant
 * evaluated the moment `vultr-provider.ts` is loaded, so a base URL exported
 * after the import is a base the allowlist has never heard of. Both sides share
 * this one because they run strictly one after the other, and each brackets its
 * own call with `take()`.
 */
const stub = await startApiStub(fixture.api);
process.env.NOMOREIDE_VULTR_API_BASE = stub.base;
const { vultrHostProvider } = await import("../src/core/vultr-context.js");
const stubs: ApiStub[] = [stub];
try {
  let compared = 0;
  compared += await pass("connected", fixture.config, fixture.plan);
  compared += await pass("disconnected", fixture.disconnected.config, fixture.disconnected.plan);
  console.log(`Host-provider parity passed (${compared} steps).`);
} finally {
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

/** One walk of a plan against one config, with a fresh home and stub per side. */
async function pass(
  label: string,
  config: Record<string, unknown>,
  plan: Step[],
): Promise<number> {
  const sides = await Promise.all(
    ["reference", "candidate"].map(async (side) => {
      const home = join(root, `${label}-${side}`);
      const configPath = join(home, ".config", "nomoreide", "config.json");
      await mkdir(join(home, ".config", "nomoreide"), { recursive: true });
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      return { side, home, configPath, stub };
    }),
  );
  const [reference, candidate] = sides;

  for (const step of plan) {
    const observed = [
      await runReference(reference, step),
      await runCandidate(candidate, step),
    ];
    if (dump) {
      for (const [index, entry] of observed.entries()) {
        console.log(`\n--- ${step.id} [${sides[index].side}]`);
        console.log(JSON.stringify(entry, null, 2));
      }
    }
    try {
      assert.deepStrictEqual(observed[1], observed[0]);
    } catch (error) {
      console.error(`\nHost-provider parity failed at step "${step.id}" (${step.op}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
  }
  return plan.length;
}

/**
 * What the value looks like once it has been sent.
 *
 * The reference builds optional fields as `value || undefined`, which leaves an
 * own key holding `undefined`; the Rust side omits the key. `JSON.stringify`
 * erases that distinction and `deepStrictEqual` does not, so without this every
 * instance with no hostname failed as a divergence that no client could ever
 * observe. Both sides serialise to JSON before anyone reads them, so the
 * serialised form is the honest thing to compare.
 */
function wireShape(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

interface Side {
  side: string;
  home: string;
  configPath: string;
  stub: ApiStub;
}

/** The TypeScript provider, called in-process against this side's stub. */
async function runReference(side: Side, step: Step): Promise<unknown> {
  side.stub.take();
  const configStore = new ConfigStore(side.configPath);
  let reported: unknown;
  try {
    reported = await referenceOperation(configStore, step);
  } catch (error) {
    reported = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return wireShape({ reported, requests: side.stub.take() });
}

async function referenceOperation(configStore: ConfigStore, step: Step): Promise<unknown> {
  switch (step.op) {
    case "status": {
      const config = await configStore.load();
      const cli = await providerCliStatus(vultrHostProvider.auth);
      const connection = publicProviderConnection(config.connections[vultrHostProvider.manifest.id]);
      const report: Record<string, unknown> = {
        provider: vultrHostProvider.manifest,
        cliAvailable: cli.available,
        cliError: cli.error ?? null,
      };
      if (connection) report.connection = connection;
      // Only the credential layer's half is compared here; the route's
      // assembly around it (auth_error vs connection_error, and the ambient
      // `{ source: "cli" }` fallback) belongs to Phase 8 with the route.
      try {
        const context = await vultrHostProvider.context(configStore);
        report.account = await context.provider.account();
      } catch (error) {
        report.account = { error: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, status: report };
    }
    case "instances": {
      const context = await vultrHostProvider.context(configStore);
      return { ok: true, instances: await context.provider.listInstances() };
    }
    case "instance": {
      const context = await vultrHostProvider.context(configStore);
      return { ok: true, instance: await context.provider.getInstance(step.args?.[0] ?? "") };
    }
    case "action": {
      const actions = await vultrHostProvider.actions(configStore);
      await actions.run(step.args?.[0] ?? "", step.args?.[1] ?? "");
      return { ok: true };
    }
  }
}

/** The Rust provider, through the probe example. */
async function runCandidate(side: Side, step: Step): Promise<unknown> {
  side.stub.take();
  const { stdout } = await execFileAsync(probeBinary, [step.op, ...(step.args ?? [])], {
    env: {
      ...process.env,
      HOME: side.home,
      XDG_CONFIG_HOME: join(side.home, ".config"),
      NOMOREIDE_VULTR_API_BASE: side.stub.base,
    },
  });
  return wireShape({ reported: JSON.parse(stdout) as unknown, requests: side.stub.take() });
}
