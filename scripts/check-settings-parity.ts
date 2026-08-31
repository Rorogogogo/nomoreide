/**
 * Phase 6 parity gate for the settings surface:
 *
 *   GET   /api/settings
 *   PATCH /api/settings/global
 *   PATCH /api/settings/project
 *   POST  /api/settings/global/reset
 *   POST  /api/settings/project/reset
 *
 * Two stores, not one. **Global** settings live in `settings.json` beside the
 * config and are per machine. **Project** preferences live in a
 * `nomoreide.config.json` inside a registered repository, so every project
 * route has to say which repository it means — and be told no when it names one
 * that is not registered.
 *
 * That scoping is most of what this gate is for. `projectPath` is resolved to
 * its canonical path and compared against the canonical path of each registered
 * repository, so a symlink pointing at a registered repo resolves *to* it and
 * is accepted for reads, while a write additionally requires the requested path
 * to be a direct directory rather than a link. A path that is merely inside a
 * registered repository is refused: the match is exact.
 *
 * The patches are validated rather than merged blindly, and a refusal carries
 * the validator's own report — bounds on `fontSize`, `scrollback` and
 * `resultLimit`, an enum for `cursorStyle`, and a strict object that refuses a
 * key it does not know. A patch is **deep** for the one level that has depth:
 * `{terminal: {fontSize}}` keeps the other terminal fields.
 *
 * Usage:
 *   node --import tsx scripts/check-settings-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-settings-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly json?: unknown;
  /** An exact body, for the shapes `JSON.stringify` cannot produce. */
  readonly raw?: string;
}

// "REPO" and "LINK" are replaced with each runtime's own paths per request.
const steps: readonly Step[] = [
  // --- reading ---------------------------------------------------------------
  { name: "read/without-a-project", method: "GET", path: "/api/settings" },
  { name: "read/with-a-project", method: "GET", path: "/api/settings?projectPath=REPO" },
  { name: "read/with-a-blank-project", method: "GET", path: "/api/settings?projectPath=%20%20" },
  { name: "read/with-an-unregistered-project", method: "GET", path: "/api/settings?projectPath=%2Ftmp" },
  { name: "read/with-a-project-that-is-not-there", method: "GET", path: "/api/settings?projectPath=%2Fnope%2Fnowhere" },
  // A symlink to a registered repo canonicalises to it, so a read is allowed.
  { name: "read/through-a-symlink", method: "GET", path: "/api/settings?projectPath=LINK" },
  // Exactly the repository, not something inside it.
  { name: "read/a-directory-inside-the-repo", method: "GET", path: "/api/settings?projectPath=REPO%2Fnested" },
  { name: "read/wrong-method", method: "POST", path: "/api/settings" },

  // --- patching the global settings -------------------------------------------
  { name: "global/one-field", method: "PATCH", path: "/api/settings/global", json: { terminal: { fontSize: 18 } } },
  { name: "global/read-back", method: "GET", path: "/api/settings" },
  { name: "global/another-field-keeps-the-first", method: "PATCH", path: "/api/settings/global", json: { terminal: { cursorStyle: "bar" } } },
  { name: "global/an-empty-patch", method: "PATCH", path: "/api/settings/global", json: {} },
  { name: "global/an-empty-terminal-patch", method: "PATCH", path: "/api/settings/global", json: { terminal: {} } },
  { name: "global/every-field", method: "PATCH", path: "/api/settings/global", json: { terminal: { fontSize: 14, cursorStyle: "underline", scrollback: 1000, copyOnSelect: true, confirmTerminate: false, smoothScroll: false, externalTerminal: "ghostty" } } },
  { name: "global/a-font-that-is-too-small", method: "PATCH", path: "/api/settings/global", json: { terminal: { fontSize: 9 } } },
  { name: "global/a-font-that-is-too-large", method: "PATCH", path: "/api/settings/global", json: { terminal: { fontSize: 25 } } },
  { name: "global/a-font-that-is-not-an-integer", method: "PATCH", path: "/api/settings/global", json: { terminal: { fontSize: 13.5 } } },
  { name: "global/a-font-that-is-not-a-number", method: "PATCH", path: "/api/settings/global", json: { terminal: { fontSize: "13" } } },
  { name: "global/a-cursor-that-is-not-one-of-the-three", method: "PATCH", path: "/api/settings/global", json: { terminal: { cursorStyle: "beam" } } },
  { name: "global/a-scrollback-below-the-floor", method: "PATCH", path: "/api/settings/global", json: { terminal: { scrollback: 499 } } },
  { name: "global/a-key-nobody-knows", method: "PATCH", path: "/api/settings/global", json: { terminal: { unknown: 1 } } },
  { name: "global/a-top-level-key-nobody-knows", method: "PATCH", path: "/api/settings/global", json: { unknown: 1 } },
  { name: "global/a-body-that-is-not-json", method: "PATCH", path: "/api/settings/global", json: undefined },
  // Not the same as `{}`: this one never reaches `JSON.parse`, and "change
  // nothing" is a request a form can legitimately make.
  { name: "global/an-empty-body", method: "PATCH", path: "/api/settings/global", raw: "" },
  { name: "global/a-body-that-is-only-whitespace", method: "PATCH", path: "/api/settings/global", raw: "   " },
  { name: "global/a-body-that-is-an-array", method: "PATCH", path: "/api/settings/global", json: [1, 2] },
  { name: "global/wrong-method", method: "POST", path: "/api/settings/global" },

  // --- patching the project preferences ---------------------------------------
  { name: "project/no-project-path", method: "PATCH", path: "/api/settings/project", json: { logs: { wrapLines: false } } },
  { name: "project/one-field", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { logs: { wrapLines: false } } },
  { name: "project/read-back", method: "GET", path: "/api/settings?projectPath=REPO" },
  { name: "project/the-other-group", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { database: { resultLimit: 250 } } },
  { name: "project/a-result-limit-below-the-floor", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { database: { resultLimit: 9 } } },
  { name: "project/a-result-limit-above-the-ceiling", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { database: { resultLimit: 5001 } } },
  { name: "project/a-key-nobody-knows", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { logs: { unknown: true } } },
  { name: "project/a-top-level-key-nobody-knows", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { unknown: true } },
  { name: "project/a-group-that-is-not-an-object", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { logs: "yes" } },
  { name: "project/a-boolean-that-is-a-string", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { logs: { wrapLines: "no" } } },
  { name: "project/a-result-limit-that-is-fractional", method: "PATCH", path: "/api/settings/project?projectPath=REPO", json: { database: { resultLimit: 12.5 } } },
  { name: "project/an-unregistered-project", method: "PATCH", path: "/api/settings/project?projectPath=%2Ftmp", json: { logs: { wrapLines: false } } },
  // A write insists on the directory itself, not a link that resolves to it.
  { name: "project/through-a-symlink", method: "PATCH", path: "/api/settings/project?projectPath=LINK", json: { logs: { wrapLines: true } } },
  { name: "project/wrong-method", method: "POST", path: "/api/settings/project" },

  // --- resetting ---------------------------------------------------------------
  { name: "reset/project", method: "POST", path: "/api/settings/project/reset?projectPath=REPO" },
  { name: "reset/project-read-back", method: "GET", path: "/api/settings?projectPath=REPO" },
  { name: "reset/project-without-a-path", method: "POST", path: "/api/settings/project/reset" },
  { name: "reset/project-through-a-symlink", method: "POST", path: "/api/settings/project/reset?projectPath=LINK" },
  { name: "reset/global", method: "POST", path: "/api/settings/global/reset" },
  { name: "reset/global-read-back", method: "GET", path: "/api/settings" },
  { name: "reset/global-wrong-method", method: "PATCH", path: "/api/settings/global/reset" },
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
  if (step.raw !== undefined) {
    headers["content-type"] = "application/json";
    body = step.raw;
  } else if (step.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(step.json);
  } else if (step.method === "PATCH") {
    // A body that is not JSON at all.
    headers["content-type"] = "application/json";
    body = "not json";
  }
  const path = step.path
    .split("REPO")
    .join(encodeURIComponent(join(runtime.home, "repo")))
    .split("LINK")
    .join(encodeURIComponent(join(runtime.home, "link")));
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

/** Both files, read as bytes rather than through the API. */
async function census(runtime: Runtime): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [label, path] of [
    ["global", join(runtime.home, ".config", "nomoreide", "settings.json")],
    ["project", join(runtime.home, "repo", "nomoreide.config.json")],
  ] as const) {
    out[label] = await readFile(path, "utf8")
      .then((value) => erase(value, runtime))
      .catch((error) => `<${error.code}>`);
  }
  return out;
}

const root = await mkdtemp(join(tmpdir(), "nmi-settings-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      (partial) => ({
        version: 1,
        services: [],
        bundles: [],
        databases: [],
        gitRepositories: [{ name: "repo", path: join(partial.home, "repo") }],
      }),
      () => [],
    );
    await mkdir(join(runtime.home, "repo", "nested"), { recursive: true });
    await symlink(join(runtime.home, "repo"), join(runtime.home, "link"));
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
    console.log("ok   settings/on-disk");
  } catch (error) {
    failures += 1;
    console.log("FAIL settings/on-disk");
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
  console.log(`settings parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`settings parity: ${total} cases match`);
