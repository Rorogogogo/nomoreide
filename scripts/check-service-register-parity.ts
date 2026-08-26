/**
 * Phase 6 parity gate for the two routes behind the "add a service" form:
 *
 *   POST /api/services        — register one
 *   POST /api/services/test   — run a candidate command and report what it did
 *
 * **Registration is a union, and its refusal says so.** The reference validates
 * against a union of three arms — local, docker-compose, ssh — so a definition
 * that satisfies none of them is refused with a report naming all three and
 * what each was missing. That report is the interesting output here, not the
 * success: a caller can fill in every field and still describe nothing
 * runnable.
 *
 * **The form is not the stored shape.** `env` and `args` arrive as JSON text
 * and are parsed before the union is tried, so their refusals are this route's
 * own wording rather than the validator's, and they come first. A field
 * belonging to another arm is dropped rather than stored.
 *
 * **The tester has three answers, not two.** A command that exits is judged on
 * its code; a command that keeps running is a *success* for a server; and a
 * command that keeps running while its port stays shut is a failure that an
 * exit code alone would have called success. This gate runs real processes and
 * is the slowest in the set for that reason.
 *
 * Usage:
 *   node --import tsx scripts/check-service-register-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-service-register-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly form?: string;
}

const q = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

/** A null byte, which several refinements refuse. Built rather than typed. */
const NUL = String.fromCharCode(0);

// "CWD" is replaced with each runtime's own workspace before a request goes out.
const steps: readonly Step[] = [
  // --- registering, the happy arms -------------------------------------------
  { name: "register/local", method: "POST", path: "/api/services", form: q({ name: "web", command: "sleep 100", cwd: "CWD", port: "4100" }) },
  { name: "register/local-with-everything", method: "POST", path: "/api/services", form: q({ name: "full", command: "sleep 100", cwd: "CWD", port: "4101", description: "a service", args: '["--flag","value"]', env: '{"TOKEN":"x"}', dependsOn: "web, ,full", projectPath: "/tmp/proj" }) },
  { name: "register/compose", method: "POST", path: "/api/services", form: q({ name: "stackman", kind: "docker-compose", cwd: "CWD", composeService: "api", composeFile: "compose.yml" }) },
  { name: "register/ssh", method: "POST", path: "/api/services", form: q({ name: "remote", kind: "ssh", host: "example.invalid", cwd: "/srv", command: "sleep 100" }) },
  // Re-registering replaces rather than duplicating.
  { name: "register/the-same-name-again", method: "POST", path: "/api/services", form: q({ name: "web", command: "sleep 200", cwd: "CWD" }) },

  // --- registering, the refusals ---------------------------------------------
  { name: "register/nothing-at-all", method: "POST", path: "/api/services", form: "" },
  { name: "register/no-name", method: "POST", path: "/api/services", form: q({ command: "sleep 100", cwd: "CWD" }) },
  { name: "register/blank-name", method: "POST", path: "/api/services", form: q({ name: "   ", command: "sleep 100", cwd: "CWD" }) },
  { name: "register/local-without-a-command", method: "POST", path: "/api/services", form: q({ name: "nocmd", cwd: "CWD" }) },
  { name: "register/local-without-a-cwd", method: "POST", path: "/api/services", form: q({ name: "nocwd", command: "sleep 100" }) },
  { name: "register/compose-without-a-service", method: "POST", path: "/api/services", form: q({ name: "nocompose", kind: "docker-compose", cwd: "CWD" }) },
  { name: "register/ssh-without-a-host", method: "POST", path: "/api/services", form: q({ name: "nohost", kind: "ssh", cwd: "/srv", command: "sleep 100" }) },
  { name: "register/an-unknown-kind", method: "POST", path: "/api/services", form: q({ name: "podman", kind: "podman", command: "sleep 100", cwd: "CWD" }) },
  // Satisfies the local arm and carries a compose field, which is dropped.
  { name: "register/local-carrying-a-compose-field", method: "POST", path: "/api/services", form: q({ name: "mixed", command: "sleep 100", cwd: "CWD", composeService: "ignored" }) },
  { name: "register/a-null-byte-in-args", method: "POST", path: "/api/services", form: q({ name: "nullish", command: "sleep 100", cwd: "CWD", args: JSON.stringify(["ok", `bad${NUL}`]) }) },
  { name: "register/an-ssh-command-with-a-null-byte", method: "POST", path: "/api/services", form: q({ name: "nullssh", kind: "ssh", host: "h", cwd: "/srv", command: `sleep${NUL}100` }) },

  // --- the form's own parsing, which runs first -------------------------------
  { name: "register/env-that-is-not-json", method: "POST", path: "/api/services", form: q({ name: "badenv", command: "sleep 100", cwd: "CWD", env: "TOKEN=x" }) },
  { name: "register/env-that-is-an-array", method: "POST", path: "/api/services", form: q({ name: "badenv", command: "sleep 100", cwd: "CWD", env: '["TOKEN"]' }) },
  { name: "register/env-with-a-bad-name", method: "POST", path: "/api/services", form: q({ name: "badenv", command: "sleep 100", cwd: "CWD", env: '{"not a name":"x"}' }) },
  { name: "register/env-with-a-dotted-name", method: "POST", path: "/api/services", form: q({ name: "badenv", command: "sleep 100", cwd: "CWD", env: '{"a.b":"x"}' }) },
  { name: "register/env-with-a-non-string-value", method: "POST", path: "/api/services", form: q({ name: "badenv", command: "sleep 100", cwd: "CWD", env: '{"TOKEN":1}' }) },
  { name: "register/args-that-are-not-json", method: "POST", path: "/api/services", form: q({ name: "badargs", command: "sleep 100", cwd: "CWD", args: "--flag" }) },
  { name: "register/args-that-are-not-an-array", method: "POST", path: "/api/services", form: q({ name: "badargs", command: "sleep 100", cwd: "CWD", args: '{"0":"--flag"}' }) },
  { name: "register/args-holding-a-number", method: "POST", path: "/api/services", form: q({ name: "badargs", command: "sleep 100", cwd: "CWD", args: "[1]" }) },
  { name: "register/an-unreadable-port", method: "POST", path: "/api/services", form: q({ name: "badport", command: "sleep 100", cwd: "CWD", port: "not-a-number" }) },
  { name: "register/a-blank-port", method: "POST", path: "/api/services", form: q({ name: "blankport", command: "sleep 100", cwd: "CWD", port: "  " }) },
  { name: "register/wrong-method", method: "PUT", path: "/api/services" },

  // --- the tester -------------------------------------------------------------
  { name: "test/a-command-that-succeeds", method: "POST", path: "/api/services/test", form: q({ command: "true", cwd: "CWD" }) },
  { name: "test/a-command-that-fails", method: "POST", path: "/api/services/test", form: q({ command: "exit 3", cwd: "CWD" }) },
  { name: "test/a-command-that-prints", method: "POST", path: "/api/services/test", form: q({ command: "echo one; echo two >&2; echo; echo three", cwd: "CWD" }) },
  { name: "test/a-command-that-is-not-there", method: "POST", path: "/api/services/test", form: q({ command: "definitely-not-a-real-binary-xyz", cwd: "CWD" }) },
  { name: "test/argv-rather-than-a-shell", method: "POST", path: "/api/services/test", form: q({ command: "echo", cwd: "CWD", args: '["from","argv"]' }) },
  // With argv there is no shell, so shell syntax is an argument, not syntax.
  { name: "test/argv-does-not-reach-a-shell", method: "POST", path: "/api/services/test", form: q({ command: "echo", cwd: "CWD", args: '["a; touch pwned"]' }) },
  { name: "test/the-env-is-passed", method: "POST", path: "/api/services/test", form: q({ command: "echo $FROM_CALLER", cwd: "CWD", env: '{"FROM_CALLER":"caller"}' }) },
  // The service's own .env is layered under the caller's env.
  { name: "test/the-dotenv-is-read", method: "POST", path: "/api/services/test", form: q({ command: "echo $FROM_DOTENV", cwd: "CWD" }) },
  { name: "test/the-caller-wins-over-the-dotenv", method: "POST", path: "/api/services/test", form: q({ command: "echo $FROM_DOTENV", cwd: "CWD", env: '{"FROM_DOTENV":"caller"}' }) },
  { name: "test/no-command", method: "POST", path: "/api/services/test", form: q({ cwd: "CWD" }) },
  { name: "test/no-cwd", method: "POST", path: "/api/services/test", form: q({ command: "true" }) },
  { name: "test/a-cwd-that-is-not-there", method: "POST", path: "/api/services/test", form: q({ command: "true", cwd: "/nope/nowhere" }) },
  { name: "test/wrong-method", method: "GET", path: "/api/services/test" },
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
  if (step.form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  const form = step.form?.split("CWD").join(encodeURIComponent(runtime.workspace));
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers,
    body: form,
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

/** The config both runtimes end up holding, and whether anything ran a shell. */
async function census(runtime: Runtime): Promise<unknown> {
  const raw = await readFile(join(runtime.home, ".config", "nomoreide", "config.json"), "utf8");
  const pwned = await readFile(join(runtime.workspace, "pwned"), "utf8")
    .then(() => "PRESENT")
    .catch(() => "<absent>");
  return { config: JSON.parse(erase(raw, runtime)), pwned };
}

const root = await mkdtemp(join(tmpdir(), "nmi-service-register-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
      () => [],
    );
    await writeFile(join(runtime.workspace, ".env"), "FROM_DOTENV=dotenv\n");
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
  console.log(`service-register parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`service-register parity: ${total} cases match`);
