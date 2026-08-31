/**
 * Phase 6 parity gate for a service's config-file surface:
 *
 *   GET      /api/services/:name/config-files
 *   GET      /api/services/:name/config-browse
 *   GET, PUT /api/services/:name/config-file
 *   GET      /api/services/:name/env/runtime
 *
 * `/api/services/:name/inspector` is deliberately **not** here. It is not a
 * route port: the Rust process manager has no HTTP inspector to toggle, so
 * serving the path would mean serving only its refusal. It stays unserved and
 * counted as remaining until the inspector itself is ported.
 *
 * These routes hand the dashboard a *file editor* scoped to one service's
 * working directory, so most of the gate is about the scoping rather than the
 * content.
 *
 * **Two refusals that look alike and are not.** A service that is not
 * registered throws out of the helper that reads its `cwd` and escapes as a
 * **500** saying "not found"; a path that climbs out of the service directory
 * is a handled **400** from the path check.
 *
 * There is a third branch in the reference — "has no working directory", a 400
 * — and it is **unreachable**. Every arm of the service schema requires a
 * non-empty `cwd`, so a service that lacks one cannot be loaded at all: the
 * config fails validation and every route answers 500 with the Zod report.
 * A fixture built to reach that branch tests the config loader instead, which
 * is how this was found. The branch is mirrored in Rust anyway, because a
 * schema that stops requiring `cwd` should not silently change these routes.
 *
 * **Only some filenames are config files at all.** `.env`, `.env.anything`,
 * `appsettings*.json` and `application*.yml|yaml` are; a plain `config.json` is
 * not, and asking for one is a refusal rather than an empty read. The fixture
 * plants both kinds, at several depths, plus a directory the walk is supposed
 * to skip and one deeper than it will go.
 *
 * **An `.env` file round-trips as entries, not text.** A PUT of entries merges
 * into the existing lines rather than replacing the file, so comments and order
 * survive — the gate PUTs into a file with both and then reads the bytes off
 * disk to prove it. Values that look secret are flagged but not masked.
 *
 * Usage:
 *   node --import tsx scripts/check-service-files-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-service-files-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly form?: string;
  readonly json?: unknown;
}

const encode = (value: string) => encodeURIComponent(value);
const file = (path: string) => `/api/services/api/config-file?path=${encode(path)}`;

const steps: readonly Step[] = [
  // --- detection -------------------------------------------------------------
  { name: "config-files/detect", method: "GET", path: "/api/services/api/config-files" },
  { name: "config-files/unregistered-service", method: "GET", path: "/api/services/ghost/config-files" },
  { name: "config-files/wrong-method", method: "POST", path: "/api/services/api/config-files" },

  // --- browsing --------------------------------------------------------------
  { name: "browse/root", method: "GET", path: "/api/services/api/config-browse" },
  { name: "browse/blank-path-is-the-root", method: "GET", path: "/api/services/api/config-browse?path=%20%20" },
  { name: "browse/a-subdirectory", method: "GET", path: `/api/services/api/config-browse?path=${encode("nested")}` },
  { name: "browse/a-dot-path", method: "GET", path: `/api/services/api/config-browse?path=${encode("./nested")}` },
  { name: "browse/an-absolute-path-inside", method: "GET", path: "/api/services/api/config-browse?path=PLACEHOLDER_NESTED" },
  // Climbing out is refused, however it is spelled.
  { name: "browse/climbing-out", method: "GET", path: `/api/services/api/config-browse?path=${encode("..")}` },
  { name: "browse/climbing-out-deeper", method: "GET", path: `/api/services/api/config-browse?path=${encode("nested/../../..")}` },
  { name: "browse/an-absolute-path-outside", method: "GET", path: `/api/services/api/config-browse?path=${encode("/etc")}` },
  // A directory that is not there reads as empty rather than as a refusal.
  { name: "browse/a-directory-that-is-not-there", method: "GET", path: `/api/services/api/config-browse?path=${encode("missing")}` },
  { name: "browse/a-file-rather-than-a-directory", method: "GET", path: `/api/services/api/config-browse?path=${encode(".env")}` },
  { name: "browse/wrong-method", method: "POST", path: "/api/services/api/config-browse" },

  // --- reading ---------------------------------------------------------------
  { name: "file/no-path", method: "GET", path: "/api/services/api/config-file" },
  { name: "file/blank-path", method: "GET", path: "/api/services/api/config-file?path=%20%20" },
  { name: "file/env", method: "GET", path: file(".env") },
  { name: "file/env-with-a-suffix", method: "GET", path: file(".env.production") },
  { name: "file/json", method: "GET", path: file("appsettings.json") },
  { name: "file/yaml", method: "GET", path: file("application.yml") },
  { name: "file/nested", method: "GET", path: file("nested/appsettings.Development.json") },
  { name: "file/does-not-exist-yet", method: "GET", path: file(".env.local") },
  // Not a config file by name, so it is refused rather than read.
  { name: "file/unsupported-name", method: "GET", path: file("config.json") },
  { name: "file/a-plain-file", method: "GET", path: file("readme.md") },
  { name: "file/climbing-out", method: "GET", path: file("../secrets.env") },
  { name: "file/absolute-outside", method: "GET", path: file("/etc/hosts") },
  { name: "file/a-null-byte", method: "GET", path: "/api/services/api/config-file?path=.env%00" },
  { name: "file/wrong-method", method: "DELETE", path: file(".env") },

  // --- writing ---------------------------------------------------------------
  // An env PUT merges: the comment and the untouched key must survive.
  { name: "put/env-merge", method: "PUT", path: file(".env"), json: { entries: [{ key: "TOKEN", value: "rotated" }, { key: "FRESH", value: "added" }] } },
  { name: "put/env-read-back", method: "GET", path: file(".env") },
  { name: "put/env-into-a-file-that-is-not-there", method: "PUT", path: file(".env.local"), json: { entries: [{ key: "ONLY", value: "one" }] } },
  { name: "put/env-with-no-entries", method: "PUT", path: file(".env"), json: {} },
  // A body that is not an object at all, which is a different refusal from a
  // body that is one and has no `entries`.
  { name: "put/env-a-body-that-is-an-array", method: "PUT", path: file(".env"), json: [1] },
  { name: "put/env-entries-that-are-not-a-list", method: "PUT", path: file(".env"), json: { entries: "TOKEN=x" } },
  // The other four ways an entry list is refused. Each has its own wording and
  // all four escape as a 500, so a gate that only pinned the first would let
  // three of them say anything at all.
  { name: "put/env-an-entry-that-is-not-an-object", method: "PUT", path: file(".env"), json: { entries: ["TOKEN=x"] } },
  { name: "put/env-a-key-that-is-not-a-name", method: "PUT", path: file(".env"), json: { entries: [{ key: "not a name", value: "x" }] } },
  { name: "put/env-a-key-that-is-missing", method: "PUT", path: file(".env"), json: { entries: [{ value: "x" }] } },
  { name: "put/env-a-value-that-is-not-a-string", method: "PUT", path: file(".env"), json: { entries: [{ key: "TOKEN", value: 1 }] } },
  { name: "put/env-a-duplicate-key", method: "PUT", path: file(".env"), json: { entries: [{ key: "TOKEN", value: "a" }, { key: "TOKEN", value: "b" }] } },
  // A dot is legal in a `.env` key and illegal in a service definition's env.
  // Two rules on purpose; this pins the permissive one.
  { name: "put/env-a-dotted-key", method: "PUT", path: file(".env"), json: { entries: [{ key: "A.B", value: "dotted" }] } },
  { name: "put/json-valid", method: "PUT", path: file("appsettings.json"), json: { content: '{\n  "a": 1\n}\n' } },
  { name: "put/json-invalid", method: "PUT", path: file("appsettings.json"), json: { content: "{ not json" } },
  { name: "put/json-content-is-not-a-string", method: "PUT", path: file("appsettings.json"), json: { content: 42 } },
  { name: "put/json-no-content", method: "PUT", path: file("appsettings.json"), json: {} },
  { name: "put/yaml-is-not-validated", method: "PUT", path: file("application.yml"), json: { content: ":\n  not: [valid\n" } },
  { name: "put/creates-missing-directories", method: "PUT", path: file("brand/new/appsettings.json"), json: { content: "{}" } },
  { name: "put/climbing-out", method: "PUT", path: file("../escape.env"), json: { entries: [] } },

  // --- runtime env -----------------------------------------------------------
  { name: "env-runtime/not-running", method: "GET", path: "/api/services/api/env/runtime" },
  { name: "env-runtime/unregistered-service", method: "GET", path: "/api/services/ghost/env/runtime" },
  { name: "env-runtime/wrong-method", method: "POST", path: "/api/services/api/env/runtime" },

];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  let body: string | undefined;
  if (step.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = step.form;
  }
  if (step.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(step.json);
  }
  const path = step.path.replace("PLACEHOLDER_NESTED", encode(join(runtime.workspace, "nested")));
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
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
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

function erase(value: string, runtime: Runtime): string {
  return value.split(`/private${runtime.home}`).join("<home>").split(runtime.home).join("<home>");
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  return { ...answer, body: JSON.parse(erase(JSON.stringify(answer.body), runtime)) };
}

/** What the writes left behind, read as bytes rather than through the API. */
async function census(runtime: Runtime): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const relative of [
    ".env",
    ".env.local",
    ".env.production",
    "appsettings.json",
    "application.yml",
    "brand/new/appsettings.json",
    "config.json",
    "../secrets.env",
    "../escape.env",
  ]) {
    out[relative] = await readFile(join(runtime.workspace, relative), "utf8").catch(
      (error) => `<${error.code}>`,
    );
  }
  return out;
}

/** The tree both runtimes get an identical copy of. */
async function seed(runtime: Runtime): Promise<void> {
  const w = runtime.workspace;
  const plant = async (relative: string, contents: string) => {
    const target = join(w, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  };

  // A file with a comment, a blank line, and a key whose name looks secret —
  // a merge has to leave the first two alone and flag the third.
  await plant(".env", "# a comment\n\nTOKEN=original\nPLAIN=value\n");
  await plant(".env.production", "MODE=prod\n");
  await plant("appsettings.json", '{ "from": "fixture" }\n');
  await plant("application.yml", "from: fixture\n");
  await plant("nested/appsettings.Development.json", '{ "nested": true }\n');
  await plant("nested/application-test.yaml", "nested: true\n");
  // Named like config but not a config file by the rule.
  await plant("config.json", '{ "not": "detected" }\n');
  await plant("readme.md", "# not config\n");
  // Inside a directory the walk skips.
  await plant("node_modules/pkg/.env", "SKIPPED=true\n");
  // Deeper than the walk goes.
  await plant("a/b/c/d/e/.env", "TOO_DEEP=true\n");
  // Outside the service directory entirely, as a target for a climb.
  await writeFile(join(runtime.home, "secrets.env"), "STOLEN=nope\n");
}

const root = await mkdtemp(join(tmpdir(), "nmi-service-files-parity-"));
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
          { name: "api", command: "sleep 100", cwd: partial.workspace, port: 4001 },
        ],
        bundles: [],
        databases: [],
        gitRepositories: [],
      }),
      () => [],
    );
    await seed(runtime);
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
      assert.deepStrictEqual(
        normalize(answers.candidate, candidate),
        normalize(answers.reference, reference),
      );
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
    console.log("ok   files/on-disk");
  } catch (error) {
    failures += 1;
    console.log("FAIL files/on-disk");
    console.log(`  reference: ${inspect(both.reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(both.candidate, { depth: null })}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

const total = steps.length + 1;
if (failures > 0) {
  console.log(`\nservice-files parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nservice-files parity: ${total} cases match`);
