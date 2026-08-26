/**
 * Phase 6 parity gate for saved log sources:
 *
 *   GET    /api/log-sources
 *   POST   /api/log-sources
 *   DELETE /api/log-sources/:name
 *   GET    /api/log-sources/:name/logs
 *
 * A log source is a file, a remote file, or a command that someone reads
 * on demand — UAT and PROD logs that nothing here spawned or supervises. Four
 * things make it worth its own gate.
 *
 * **Three error vocabularies over one form.** `name` and `kind` are read with
 * the unwrapped form helpers, so a missing name or an unknown kind escapes as a
 * **500** carrying prose. The schema behind them is caught, so its refusals are
 * a **400** carrying zod's report. And a *read* that fails — a file that is not
 * there, a command that exits non-zero — is answered **200** with
 * `{ ok: false, error }`, because the dashboard renders it in the log pane
 * rather than as a failed request. Three statuses, and only cases keep them
 * apart.
 *
 * **A driver overrides the kind.** `driver: journald` returns early from the
 * schema's refinement, so a source can be `kind: "file"` with no `path` and
 * still be valid. That early return is easy to lose and invisible without a
 * case that depends on it.
 *
 * **The filters are the reference's regexes.** `grep` is compiled as a regex
 * and falls back to a literal match when it does not compile; `level: error`
 * keeps stderr *or* anything matching the error word-pattern, and `level: warn`
 * keeps those plus the warn pattern. A file tail arrives as one stream, so
 * those patterns are also what decides which lines render red.
 *
 * **`lines` is clamped, not validated.** Absent, zero, negative and unreadable
 * all mean 500; anything above 5000 becomes 5000; a fractional value is
 * floored. None of that is reported — it just changes how much comes back.
 *
 * journald and docker sources are registered and read back, but not *read*:
 * neither `journalctl` nor a docker daemon exists on the machines this runs on,
 * so a read is the same "command not found" on both sides and proves nothing
 * about the argv. The argv builders are covered by unit tests instead.
 *
 * Usage:
 *   node --import tsx scripts/check-log-sources-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-log-sources-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly form?: string;
}

const encode = encodeURIComponent;
const q = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${encode(value)}`)
    .join("&");

/** `WORKSPACE` is replaced with each runtime's own workspace per request. */
const steps: readonly Step[] = [
  // --- listing ---------------------------------------------------------------
  { name: "list/empty", method: "GET", path: "/api/log-sources" },
  // An exact route, so a wrong method falls through to the SPA shell's 404.
  { name: "list/wrong-method", method: "PUT", path: "/api/log-sources" },

  // --- registering -----------------------------------------------------------
  { name: "register/a-file-source", method: "POST", path: "/api/log-sources", form: q({ name: "uat", kind: "file", path: "WORKSPACE/uat.log" }) },
  { name: "register/read-back", method: "GET", path: "/api/log-sources" },
  { name: "register/an-ssh-source", method: "POST", path: "/api/log-sources", form: q({ name: "prod", kind: "ssh", host: "example.invalid", path: "/var/log/app.log" }) },
  { name: "register/a-command-source", method: "POST", path: "/api/log-sources", form: q({ name: "cmd", kind: "command", command: "cat lines.log", cwd: "WORKSPACE" }) },
  // A driver returns early from the refinement, so the kind's own requirements
  // never run: this is a `file` source with no `path` and it is still valid.
  { name: "register/a-journald-source", method: "POST", path: "/api/log-sources", form: q({ name: "journal", kind: "file", driver: "journald", unit: "nginx" }) },
  { name: "register/a-docker-source", method: "POST", path: "/api/log-sources", form: q({ name: "container", kind: "file", driver: "docker", container: "api" }) },
  // Replacing keeps the name once and moves it to the end of the list.
  { name: "register/the-same-name-again", method: "POST", path: "/api/log-sources", form: q({ name: "uat", kind: "file", path: "WORKSPACE/other.log" }) },
  { name: "register/replaced-read-back", method: "GET", path: "/api/log-sources" },
  // A field that belongs to no shape at all.
  { name: "register/an-unknown-field", method: "POST", path: "/api/log-sources", form: q({ name: "extra", kind: "file", path: "WORKSPACE/uat.log", nonsense: "kept?" }) },

  // --- registering: the unwrapped refusals (500) -----------------------------
  { name: "register/nothing-at-all", method: "POST", path: "/api/log-sources", form: "" },
  { name: "register/no-name", method: "POST", path: "/api/log-sources", form: q({ kind: "file", path: "/tmp/x.log" }) },
  { name: "register/a-blank-name", method: "POST", path: "/api/log-sources", form: q({ name: "   ", kind: "file", path: "/tmp/x.log" }) },
  { name: "register/no-kind", method: "POST", path: "/api/log-sources", form: q({ name: "kindless", path: "/tmp/x.log" }) },
  { name: "register/an-unknown-kind", method: "POST", path: "/api/log-sources", form: q({ name: "odd", kind: "syslog", path: "/tmp/x.log" }) },
  { name: "register/an-unknown-driver", method: "POST", path: "/api/log-sources", form: q({ name: "odd", kind: "file", path: "/tmp/x.log", driver: "splunk" }) },

  // --- registering: the schema's refusals (400) ------------------------------
  { name: "register/a-file-without-a-path", method: "POST", path: "/api/log-sources", form: q({ name: "nopath", kind: "file" }) },
  // A blank optional is dropped before the schema sees it, so this is the same
  // refusal as sending nothing at all rather than a "too small" one.
  { name: "register/a-file-with-a-blank-path", method: "POST", path: "/api/log-sources", form: q({ name: "nopath", kind: "file", path: "   " }) },
  { name: "register/an-ssh-without-a-host", method: "POST", path: "/api/log-sources", form: q({ name: "nohost", kind: "ssh", path: "/var/log/app.log" }) },
  { name: "register/an-ssh-without-a-path", method: "POST", path: "/api/log-sources", form: q({ name: "nopath2", kind: "ssh", host: "h" }) },
  { name: "register/a-command-without-a-command", method: "POST", path: "/api/log-sources", form: q({ name: "nocmd", kind: "command", cwd: "/tmp" }) },
  { name: "register/journald-without-a-unit", method: "POST", path: "/api/log-sources", form: q({ name: "nounit", kind: "file", driver: "journald" }) },
  { name: "register/docker-without-a-container", method: "POST", path: "/api/log-sources", form: q({ name: "nocontainer", kind: "file", driver: "docker" }) },
  { name: "register/wrong-method", method: "PUT", path: "/api/log-sources" },

  // --- reading ---------------------------------------------------------------
  { name: "logs/a-file-source", method: "GET", path: "/api/log-sources/tail/logs" },
  // `uat` was repointed by `register/the-same-name-again`, so this reads the
  // replacement rather than the file it was registered with.
  { name: "logs/a-repointed-source", method: "GET", path: "/api/log-sources/uat/logs" },
  { name: "logs/an-unknown-source", method: "GET", path: "/api/log-sources/ghost/logs" },
  { name: "logs/a-file-that-is-not-there", method: "GET", path: "/api/log-sources/missing/logs" },
  // `lines` is clamped rather than reported: none of these four is a refusal.
  { name: "logs/two-lines", method: "GET", path: "/api/log-sources/tail/logs?lines=2" },
  { name: "logs/zero-lines", method: "GET", path: "/api/log-sources/tail/logs?lines=0" },
  { name: "logs/negative-lines", method: "GET", path: "/api/log-sources/tail/logs?lines=-5" },
  { name: "logs/lines-that-are-not-a-number", method: "GET", path: "/api/log-sources/tail/logs?lines=plenty" },
  { name: "logs/fractional-lines", method: "GET", path: "/api/log-sources/tail/logs?lines=2.9" },
  // Both of these need a file longer than the ceiling, or the clamp and the
  // default are the same answer as "everything" and neither is observable.
  { name: "logs/the-default-is-five-hundred", method: "GET", path: "/api/log-sources/bulk/logs" },
  { name: "logs/lines-above-the-ceiling", method: "GET", path: "/api/log-sources/bulk/logs?lines=99999" },
  { name: "logs/lines-below-the-ceiling", method: "GET", path: "/api/log-sources/bulk/logs?lines=4999" },
  { name: "logs/grep", method: "GET", path: `/api/log-sources/tail/logs?grep=${encode("second")}` },
  { name: "logs/grep-is-a-regex", method: "GET", path: `/api/log-sources/tail/logs?grep=${encode("^th.rd")}` },
  { name: "logs/grep-is-case-insensitive", method: "GET", path: `/api/log-sources/tail/logs?grep=${encode("SECOND")}` },
  // Not a valid regex, so it falls back to a literal match.
  { name: "logs/grep-that-is-not-a-regex", method: "GET", path: `/api/log-sources/tail/logs?grep=${encode("[bracket")}` },
  { name: "logs/grep-that-is-not-a-regex-and-matches-nothing", method: "GET", path: `/api/log-sources/tail/logs?grep=${encode("[unclosed")}` },
  { name: "logs/grep-that-matches-nothing", method: "GET", path: `/api/log-sources/tail/logs?grep=${encode("nowhere")}` },
  { name: "logs/level-error", method: "GET", path: "/api/log-sources/tail/logs?level=error" },
  { name: "logs/level-warn", method: "GET", path: "/api/log-sources/tail/logs?level=warn" },
  // Only `warn` and `error` are read; anything else is no filter at all.
  { name: "logs/level-nonsense", method: "GET", path: "/api/log-sources/tail/logs?level=trace" },
  { name: "logs/grep-and-level-together", method: "GET", path: `/api/log-sources/tail/logs?level=error&grep=${encode("fail")}` },
  { name: "logs/a-command-source", method: "GET", path: "/api/log-sources/cmd/logs" },
  { name: "logs/a-command-that-fails", method: "GET", path: "/api/log-sources/broken/logs" },
  { name: "logs/a-command-that-writes-to-stderr", method: "GET", path: "/api/log-sources/noisy/logs" },
  { name: "logs/wrong-method", method: "POST", path: "/api/log-sources/uat/logs" },

  // --- deleting --------------------------------------------------------------
  { name: "delete/a-source", method: "DELETE", path: "/api/log-sources/prod" },
  { name: "delete/the-same-one-again", method: "DELETE", path: "/api/log-sources/prod" },
  { name: "delete/one-nobody-registered", method: "DELETE", path: "/api/log-sources/ghost" },
  { name: "delete/an-encoded-name", method: "DELETE", path: `/api/log-sources/${encode("with space")}` },
  // The name is taken as sent. Removal does not trim it, unlike the workflow
  // route next door, so a padded name removes nothing.
  { name: "delete/a-padded-name", method: "DELETE", path: `/api/log-sources/${encode("  cmd  ")}` },
  { name: "delete/wrong-method", method: "GET", path: "/api/log-sources/uat" },
  { name: "delete/read-back", method: "GET", path: "/api/log-sources" },
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
  const path = step.path.split("WORKSPACE").join(runtime.workspace);
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: step.method,
    headers,
    body: step.form?.split(encode("WORKSPACE")).join(encode(runtime.workspace)),
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

/** The config each runtime is left holding. */
async function census(runtime: Runtime): Promise<unknown> {
  const raw = await readFile(join(runtime.home, ".config", "nomoreide", "config.json"), "utf8");
  return JSON.parse(erase(raw, runtime));
}

const root = await mkdtemp(join(tmpdir(), "nmi-log-sources-parity-"));
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
        gitRepositories: [],
        logSources: [
          // A file that is not there, so a read is a handled failure rather
          // than an empty list.
          { name: "missing", kind: "file", path: join(partial.workspace, "gone.log") },
          // A command that exits non-zero, and one that writes to both pipes.
          { name: "broken", kind: "command", command: "exit 4", cwd: partial.workspace },
          {
            name: "noisy",
            kind: "command",
            command: "echo out; echo trouble >&2",
            cwd: partial.workspace,
          },
          { name: "with space", kind: "file", path: join(partial.workspace, "uat.log") },
          // Read-only: no case re-registers this name, so the filter cases
          // below always see the whole fixture file. `uat` is repointed
          // half-way through and cannot be used for them.
          { name: "tail", kind: "file", path: join(partial.workspace, "uat.log") },
          // Longer than the 5000-line ceiling, so the clamp and the 500-line
          // default are both visible.
          { name: "bulk", kind: "file", path: join(partial.workspace, "bulk.log") },
        ],
      }),
      () => [],
    );
    // A tail with a blank line, a trailing newline, and lines the error and
    // warn patterns are supposed to pick out of a single stdout stream.
    await writeFile(
      join(runtime.workspace, "uat.log"),
      [
        "first line",
        "the second line",
        "third line",
        "",
        "a WARNING here",
        "it failed hard",
        // Not a valid regex, so `grep=[bracket` reaches the literal fallback —
        // and has something to match once it gets there.
        "a [bracket line",
        "",
      ].join("\n"),
    );
    await writeFile(join(runtime.workspace, "other.log"), "replaced\n");
    await writeFile(join(runtime.workspace, "lines.log"), "one\ntwo\n");
    await writeFile(
      join(runtime.workspace, "bulk.log"),
      `${Array.from({ length: 5001 }, (_, index) => `line ${index}`).join("\n")}\n`,
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
  console.log(`\nlog-sources parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nlog-sources parity: ${total} cases match`);
