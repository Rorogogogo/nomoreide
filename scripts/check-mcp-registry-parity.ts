/**
 * Phase 5 profile-registry parity gate.
 *
 * The three tools that reach the hosted registry. Each runtime gets its own
 * loopback stand-in for the API, so the gate compares not only what a tool
 * reported but every request it made — the method, the path, the bearer token,
 * and the body. Publishing is a chain of five calls, and a runtime that made
 * four of them, or made them in another order, would otherwise look identical
 * from the answer alone.
 *
 * Nothing here reads either implementation.
 * `test/fixtures/mcp-registry-parity-v1.json` holds the planted tree, the
 * stub's routes, and the ordered plan; both runtimes see the same one.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-registry-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 *   ... --probe   run the reference alone and print what it answered
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callMcpTool } from "../test/support/mcp-contract.js";
import {
  type FixtureTree,
  type Runtime,
  mcpCommand,
  normalize,
  prepareRuntime,
  repositoryRoot,
  substitute,
} from "./support/mcp-parity-fixture.js";

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const probe = argv.includes("--probe");
const candidateArgv = argv.filter((argument) => !argument.startsWith("--"));
if (candidateArgv.length === 0 && !probe) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-registry-parity.ts [--dump] [--probe] <candidate-command> [candidate-args...]",
  );
}

interface Route {
  method: string;
  path: string;
  status?: number;
  /** JSON body. `{{api}}` in any string resolves to this runtime's stub base. */
  body?: unknown;
  /** Serve a home-relative file's bytes instead, as `application/gzip`. */
  file?: string;
}

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
  matched: boolean;
}

interface Step {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Environment for this call only — the registry token, mostly. */
  env?: Record<string, string>;
  /**
   * Home-relative files to write before this step.
   *
   * A sign-in is a file, not an environment variable, and the environment is
   * only supposed to *outrank* it — so proving that needs both present and
   * disagreeing. Written to both runtimes, so the two are asked the same
   * question.
   */
  writeHomeFiles?: Array<{ path: string; contents: string }>;
  /**
   * Home-relative files to delete first. The pre-rename config is only a
   * *fallback*, so it is unreachable until the current one is gone — and an
   * empty current one does not count as gone.
   */
  removeHomeFiles?: string[];
}

interface Fixture extends FixtureTree {
  fixtureVersion: 1;
  pathStubs: string[];
  api: Route[];
  plan: Step[];
}

const fixture = JSON.parse(
  await readFile(join(repositoryRoot, "test/fixtures/mcp-registry-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported registry parity fixture version ${fixture.fixtureVersion}`);
}

const specs = [
  { label: "reference", command: process.execPath, args: ["--import", "tsx", "src/index.ts"] },
  ...(probe ? [] : [{ label: "candidate", command: candidateArgv[0], args: candidateArgv.slice(1) }]),
];

interface Stub {
  base: string;
  take(): RecordedRequest[];
  close(): Promise<void>;
}

const roots: string[] = [];
const stubs: Stub[] = [];
try {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    const runtime = await prepareRuntime(spec, fixture, roots);
    runtime.env.PATH = `${join(runtime.home, "bin")}:${process.env.PATH ?? ""}`;
    runtime.env.SHELL = "/bin/sh";
    const stub = await startStub(fixture.api, runtime);
    stubs.push(stub);
    // The seam the reference already has for pointing the registry elsewhere.
    // Without it these tools would reach the real api.nomoreide.com.
    runtime.env.NOMOREIDE_API_BASE_URL = stub.base;
    // A stale sign-in on the machine running the gate must not leak in, and
    // neither must the pre-rename names the reference still falls back to.
    for (const name of [
      "NOMOREIDE_API_TOKEN",
      "BRAINCTL_API_TOKEN",
      "BRAINCTL_API_BASE_URL",
      "BRAINCTL_API_URL",
      "NOMOREIDE_API_URL",
    ]) {
      delete runtime.env[name];
    }
    runtimes.push(runtime);
  }

  for (const step of fixture.plan) {
    for (const runtime of runtimes) {
      for (const file of step.removeHomeFiles ?? []) {
        await rm(join(runtime.home, file), { recursive: true, force: true });
      }
      for (const file of step.writeHomeFiles ?? []) {
        const target = join(runtime.home, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, substitute(file.contents, runtime) as string);
      }
    }
    const observed = await Promise.all(
      runtimes.map((runtime, index) => call(runtime, stubs[index], step)),
    );
    if (dump || probe) {
      for (const [index, entry] of observed.entries()) {
        console.log(`\n--- ${step.id} [${runtimes[index].label}]`);
        console.log(JSON.stringify(entry, null, 2));
      }
    }
    if (probe) continue;
    try {
      assert.deepStrictEqual(observed[1], observed[0]);
      // And in order. A publish is five calls; making them in another order is
      // a different conversation with the registry, and `deepStrictEqual` on
      // the objects inside would not see it.
      assert.strictEqual(JSON.stringify(observed[1]), JSON.stringify(observed[0]));
    } catch (error) {
      console.error(`\nRegistry parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(observed[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(observed[1], null, 2)}`);
      throw error;
    }
  }
  console.log(
    probe
      ? `Registry probe finished (${fixture.plan.length} steps against the reference only).`
      : `MCP profile-registry parity passed (${fixture.plan.length} steps).`,
  );
} finally {
  await Promise.all(stubs.map((stub) => stub.close().catch(() => {})));
  await Promise.all(
    roots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    ),
  );
}

async function call(runtime: Runtime, stub: Stub, step: Step): Promise<unknown> {
  const args = Object.fromEntries(
    Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
  );
  const command = mcpCommand(runtime);
  stub.take();
  const answered = await callMcpTool(
    step.env ? { ...command, env: { ...command.env, ...step.env } } : command,
    step.tool,
    args,
  );
  const asked = stub.take().map((request) => ({
    ...request,
    path: request.path.split(stub.base).join("<api>"),
  }));
  return {
    answered: normalize(answered, runtime),
    asked: JSON.parse(JSON.stringify(asked).split(stub.base).join("<api>")),
  };
}

/**
 * A loopback stand-in for the registry API, one per runtime.
 *
 * It records what it was asked as well as answering, because the publish chain
 * is only observable from the request side: the tool reports the same four
 * fields whether it uploaded a package or not.
 */
async function startStub(routes: Route[], runtime: Runtime): Promise<Stub> {
  let recorded: RecordedRequest[] = [];
  let base = "";
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      const route = routes.find(
        (candidate) => candidate.method === request.method && candidate.path === (request.url ?? ""),
      );
      recorded.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization ?? null,
        contentType: request.headers["content-type"] ?? null,
        body: readBody(raw),
        matched: Boolean(route),
      });
      response.statusCode = route?.status ?? (route ? 200 : 404);
      if (route?.file) {
        response.setHeader("content-type", "application/gzip");
        response.end(await readFile(join(runtime.home, route.file)).catch(() => Buffer.alloc(0)));
        return;
      }
      response.setHeader("content-type", "application/json");
      // `{{api}}` is this stub's own base, which only exists once it is
      // listening — so it is filled in here rather than by the fixture's own
      // substitution, which runs before that.
      response.end(
        JSON.stringify(substitute(route?.body ?? { message: "Not Found" }, runtime)).split(
          "{{api}}",
        ).join(base),
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    take() {
      const taken = recorded;
      recorded = [];
      return taken;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * What a request carried, in a form two runtimes can be held to.
 *
 * A package upload is a gzip stream, and two packers do not produce the same
 * bytes for the same files — nor even the same *number* of bytes, because a
 * tar records each file's mtime. So an archive body is reduced to the fact
 * that it was one. That it holds the right files is the export gate's job.
 */
function readBody(raw: Buffer): unknown {
  if (!raw.length) return null;
  if (raw[0] === 0x1f && raw[1] === 0x8b) return { gzipArchive: true };
  const text = raw.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
}
