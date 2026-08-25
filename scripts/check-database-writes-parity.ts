/**
 * Phase 6 parity gate for the database domain's two write routes: `execute` and
 * `catalog/rows/delete`. (`catalog/export` is the domain's third remaining
 * route and has a gate of its own, because it answers with a file rather than
 * a payload.)
 *
 * These are the domain's only writes, so the gate checks two things the read
 * gates never had to:
 *
 *  - **The unlock actually gates.** Every write case runs twice, once against a
 *    connection whose `writeUnlocked` is set and once against one whose is not.
 *    A route that reported a refusal while committing anyway would pass a
 *    body-only comparison, so the fixture's rows are counted afterwards.
 *  - **Preview and commit are different answers to the same request.** A
 *    preview reports what a commit would touch and leaves the table alone, and
 *    a commit is refused outright unless the caller confirms the count that
 *    preview reported.
 *
 * Each mutating case owns its own table, so the cases do not have to run in any
 * particular order to mean anything, and the final row count of every table is
 * compared as a step of its own.
 *
 * SQLite only, for the reason the other database gates give: a fixture that
 * needed a Postgres server would be testing the server.
 *
 * Usage:
 *   node --import tsx scripts/check-database-writes-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    "Usage: node --import tsx scripts/check-database-writes-parity.ts [--dump] <candidate> [args...]",
  );
}

type Keys = (label: string) => string;

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path?: string;
  readonly pathFor?: (keys: Keys) => string;
  readonly form?: string;
  readonly formFor?: (keys: Keys) => string;
  /** Headers to compare beyond the status and body. */
  readonly headers?: readonly string[];
  /**
   * Compare the body as the exact text it was, never parsed.
   *
   * An export is a *file*, so its bytes are the payload: a JSON export that
   * ends without its trailing newline parses identically and downloads
   * differently.
   */
  readonly raw?: boolean;
}

const encode = (value: string) => encodeURIComponent(value);
const q = (value: unknown) => encode(JSON.stringify(value));

/** Tables a mutating case may empty without spoiling another case. */
const VICTIMS = [
  "del_preview",
  "del_commit",
  "del_locked",
  "del_expected",
  "del_mismatch",
  "del_gone",
  "exec_first",
  "exec_second",
  "exec_preview",
  "exec_commit",
  "exec_locked",
] as const;

const SCHEMA: readonly string[] = [
  ...VICTIMS.flatMap((table) => [
    `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL, note TEXT)`,
    `INSERT INTO ${table} (id, label, note) VALUES (1,'one','a'), (2,'two',NULL), (3,'three','c')`,
  ]),
  // Read-only fixtures for export.
  // `api_token` is here because an export masks a secret-looking column the
  // same way the row browser does; `signed` and `typed` separate a negative
  // *number* from a string that merely starts like a formula.
  "CREATE TABLE catalogue (id INTEGER PRIMARY KEY, title TEXT, price REAL, blobby BLOB, missing TEXT, api_token TEXT, signed REAL, typed TEXT)",
  `INSERT INTO catalogue VALUES
     (1,'plain',1.5,x'00ff',NULL,'tok',-5,'-5'),
     (2,'has,comma',2,NULL,'x','tok2',0,'+1'),
     (3,'has""quote',3,NULL,'y',NULL,1,'@home'),
     (4,'=formula',4,NULL,'z','tok4',2,'  =late'),
     (5,'multi
line',5,NULL,NULL,'tok5',3,'	tabbed')`,
  "CREATE TABLE empty_export (id INTEGER PRIMARY KEY, only TEXT)",
  "CREATE VIEW v_catalogue AS SELECT id, title FROM catalogue",
  "CREATE TABLE composite (a INTEGER NOT NULL, b TEXT NOT NULL, payload TEXT, PRIMARY KEY (a, b))",
  "INSERT INTO composite VALUES (1,'x','first'), (1,'y','second'), (2,'x','third')",
  "CREATE TABLE no_primary_key (a INTEGER, b TEXT)",
  "INSERT INTO no_primary_key VALUES (1,'x'), (2,'y')",
];

const steps: readonly Step[] = [
  // === execute =============================================================
  { name: "execute/preview", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("UPDATE exec_preview SET note = 'touched'")}` },
  { name: "execute/preview-is-the-default-mode", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("DELETE FROM exec_preview")}&mode=dry-run` },
  { name: "execute/commit", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("DELETE FROM exec_commit WHERE id = 2")}&mode=commit` },
  { name: "execute/locked-connection-refuses", method: "POST", path: "/api/databases/locked/execute", form: `sql=${encode("DELETE FROM exec_locked")}&mode=commit` },
  { name: "execute/locked-connection-refuses-a-preview", method: "POST", path: "/api/databases/locked/execute", form: `sql=${encode("DELETE FROM exec_locked")}` },
  { name: "execute/relocked-connection-refuses", method: "POST", path: "/api/databases/relocked/execute", form: `sql=${encode("DELETE FROM exec_locked")}&mode=commit` },
  { name: "execute/a-read-statement", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("SELECT 1")}` },
  // Does `affectedRows` count rows changed or rows returned? A read of three
  // rows answers it.
  { name: "execute/select-many-rows", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("SELECT id FROM exec_preview ORDER BY id")}` },
  { name: "execute/select-no-rows", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("SELECT id FROM exec_preview WHERE 0")}` },
  // DDL is deliberately absent. `CREATE TABLE` reports an `affectedRows` that
  // SQLite left over from the last DML on the same connection -- the reference
  // answered 1 only because the case before it deleted one row -- so it is an
  // artefact of case order, not a behaviour to reproduce.
  { name: "execute/pragma", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("PRAGMA user_version")}` },
  { name: "execute/two-statements", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("DELETE FROM exec_preview; DELETE FROM exec_commit")}` },
  // Committed, so the row census sees whether the second statement ran.
  { name: "execute/two-statements-committed", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("DELETE FROM exec_first WHERE id = 1; DELETE FROM exec_second")}&mode=commit` },
  { name: "execute/semicolon-inside-a-literal", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("UPDATE exec_first SET label = 'a;b' WHERE id = 2; DELETE FROM exec_second")}&mode=commit` },
  { name: "execute/trailing-semicolon", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("DELETE FROM exec_preview;")}` },
  { name: "execute/syntax-error", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("UPDAT exec_preview SET note = 1")}` },
  { name: "execute/unknown-table", method: "POST", path: "/api/databases/demo/execute", form: `sql=${encode("DELETE FROM ghost")}` },
  { name: "execute/missing-sql", method: "POST", path: "/api/databases/demo/execute", form: "mode=commit" },
  { name: "execute/blank-sql", method: "POST", path: "/api/databases/demo/execute", form: "sql=%20%20&mode=commit" },
  // Which refusal wins when two apply: the lock is checked before the statement
  // is looked at, or it is not.
  { name: "execute/locked-connection-with-bad-sql", method: "POST", path: "/api/databases/locked/execute", form: `sql=${encode("UPDAT nothing")}` },
  { name: "execute/locked-connection-with-a-read", method: "POST", path: "/api/databases/locked/execute", form: `sql=${encode("SELECT 1")}` },
  { name: "execute/unknown-connection", method: "POST", path: "/api/databases/nope/execute", form: `sql=${encode("SELECT 1")}` },
  { name: "execute/wrong-method", method: "GET", path: "/api/databases/demo/execute" },

  // === delete rows =========================================================
  { name: "delete/preview", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q([{ id: 1 }])}` },
  { name: "delete/commit", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_commit"))}&mode=commit&tuples=${q([{ id: 1 }, { id: 3 }])}` },
  { name: "delete/locked-connection-refuses", method: "POST", path: "/api/databases/locked/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_locked"))}&mode=commit&tuples=${q([{ id: 1 }])}` },
  { name: "delete/relocked-connection-refuses", method: "POST", path: "/api/databases/relocked/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_locked"))}&mode=commit&tuples=${q([{ id: 1 }])}&expectedAffectedRows=1` },
  { name: "delete/expected-rows-agree", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_expected"))}&mode=commit&tuples=${q([{ id: 1 }])}&expectedAffectedRows=1` },
  // The confirmed count agrees with the tuples, so the up-front check passes --
  // but one of those rows is already gone, so the delete affects fewer than the
  // caller confirmed. Whether that is refused or committed is the difference
  // between confirming an intent and confirming an outcome.
  { name: "delete/expected-rows-agree-but-a-row-is-missing", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_gone"))}&mode=commit&tuples=${q([{ id: 1 }, { id: 99 }])}&expectedAffectedRows=2` },
  { name: "delete/view", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("view:v_catalogue"))}&mode=preview&tuples=${q([{ id: 1 }])}` },
  { name: "delete/duplicate-tuples", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q([{ id: 1 }, { id: 1 }])}` },
  { name: "delete/null-in-a-tuple", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q([{ id: null }])}` },
  { name: "delete/masked-value-in-a-tuple", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q([{ id: "\u2022\u2022\u2022\u2022" }])}` },
  { name: "delete/exactly-one-hundred-tuples", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q(Array.from({ length: 100 }, (_, i) => ({ id: i + 1000 })))}` },
  { name: "delete/one-hundred-and-one-tuples", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q(Array.from({ length: 101 }, (_, i) => ({ id: i + 1000 })))}` },
  { name: "delete/expected-rows-disagree", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_mismatch"))}&mode=commit&tuples=${q([{ id: 1 }])}&expectedAffectedRows=7` },
  { name: "delete/composite-primary-key", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:composite"))}&mode=preview&tuples=${q([{ a: 1, b: "x" }])}` },
  { name: "delete/partial-composite-key", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:composite"))}&mode=preview&tuples=${q([{ a: 1 }])}` },
  { name: "delete/extra-column-in-tuple", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:composite"))}&mode=preview&tuples=${q([{ a: 1, b: "x", payload: "first" }])}` },
  { name: "delete/table-without-a-primary-key", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:no_primary_key"))}&mode=preview&tuples=${q([{ a: 1 }])}` },
  { name: "delete/no-tuples", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q([])}` },
  { name: "delete/too-many-tuples", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q(Array.from({ length: 501 }, (_, i) => ({ id: i })))}` },
  { name: "delete/tuples-are-not-json", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=oops` },
  { name: "delete/tuples-are-not-an-array", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q({ id: 1 })}` },
  { name: "delete/unknown-mode", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=maybe&tuples=${q([{ id: 1 }])}` },
  { name: "delete/missing-mode", method: "POST", path: "/api/databases/demo/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&tuples=${q([{ id: 1 }])}` },
  { name: "delete/missing-key", method: "POST", path: "/api/databases/demo/catalog/rows/delete", form: `mode=preview&tuples=${q([{ id: 1 }])}` },
  { name: "delete/undecodable-key", method: "POST", path: "/api/databases/demo/catalog/rows/delete", form: `key=not-a-key&mode=preview&tuples=${q([{ id: 1 }])}` },
  { name: "delete/locked-connection-with-bad-tuples", method: "POST", path: "/api/databases/locked/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_locked"))}&mode=preview&tuples=oops` },
  { name: "delete/unknown-connection", method: "POST", path: "/api/databases/nope/catalog/rows/delete", formFor: (k) => `key=${encode(k("table:del_preview"))}&mode=preview&tuples=${q([{ id: 1 }])}` },
  { name: "delete/wrong-method", method: "GET", path: "/api/databases/demo/catalog/rows/delete" },
  // The route sits one segment past `catalog/rows`, which must still be a read.
  { name: "delete/does-not-shadow-the-row-reader", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:del_preview"))}` },
];

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | null>;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step, keys: Keys): Promise<Answer> {
  const path = step.pathFor ? step.pathFor(keys) : (step.path as string);
  const form = step.formFor ? step.formFor(keys) : step.form;
  const credential = await credentialOf(runtime);
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  if (form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: step.method,
    headers,
    body: form,
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (!step.raw) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* compared as the text it was */
    }
  }
  const compared: Record<string, string | null> = {};
  for (const header of step.headers ?? []) compared[header] = response.headers.get(header);
  return { status: response.status, headers: compared, body: parsed };
}

const credentials = new Map<Runtime, string>();
async function credentialOf(runtime: Runtime): Promise<string> {
  const cached = credentials.get(runtime);
  if (cached !== undefined) return cached;
  const value = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((text) => text.trim())
    .catch(() => "");
  credentials.set(runtime, value);
  return value;
}

function erase(value: string, runtime: Runtime): string {
  return value.split(`/private${runtime.home}`).join("<home>").split(runtime.home).join("<home>");
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  return { ...answer, body: JSON.parse(erase(JSON.stringify(answer.body), runtime)) };
}

async function keysOf(runtime: Runtime): Promise<Keys> {
  const answer = await send(
    runtime,
    { name: "prelude", method: "GET", path: "/api/databases/demo/catalog/objects?schema=main" },
    () => "",
  );
  const body = answer.body as { objects?: Array<{ kind: string; name: string; key: string }> };
  const table = new Map((body.objects ?? []).map((o) => [`${o.kind}:${o.name}`, o.key]));
  return (label) => table.get(label) ?? `missing-key-for-${label}`;
}

function seedDatabase(path: string, statements: readonly string[]): void {
  const handle = new DatabaseSync(path);
  try {
    for (const statement of statements) handle.exec(statement);
  } finally {
    handle.close();
  }
}

/** What each fixture table holds once every case has run. */
function census(path: string): Record<string, unknown> {
  const handle = new DatabaseSync(path);
  try {
    const out: Record<string, unknown> = {};
    for (const table of [...VICTIMS, "composite", "catalogue", "no_primary_key"]) {
      out[table] = handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    return out;
  } finally {
    handle.close();
  }
}

const root = await mkdtemp(join(tmpdir(), "nmi-db-writes-parity-"));
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
        databases: [
          { name: "demo", engine: "sqlite", url: join(partial.home, "demo.db"), writeUnlocked: true },
          // The same file, reached through a connection nobody unlocked.
          { name: "locked", engine: "sqlite", url: join(partial.home, "demo.db") },
          // And one someone unlocked and then locked again, which stores the
          // flag as `false` rather than removing it. A check that only asks
          // whether the flag is *present* lets this one write.
          { name: "relocked", engine: "sqlite", url: join(partial.home, "demo.db"), writeUnlocked: false },
          { name: "odd name/slash", engine: "sqlite", url: join(partial.home, "demo.db"), writeUnlocked: true },
        ],
        gitRepositories: [],
      }),
      () => [],
    );
    seedDatabase(join(runtime.home, "demo.db"), SCHEMA);
    await harness.startDaemon(runtime, {});
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;
  const keys = { reference: await keysOf(reference), candidate: await keysOf(candidate) };

  for (const step of steps) {
    const answers = {
      reference: await send(reference, step, keys.reference),
      candidate: await send(candidate, step, keys.candidate),
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

  // What each runtime's fixture actually holds. A route that reported a refusal
  // and committed anyway passes every step above and fails here.
  const both = {
    reference: census(join(reference.home, "demo.db")),
    candidate: census(join(candidate.home, "demo.db")),
  };
  try {
    assert.deepStrictEqual(both.candidate, both.reference);
    console.log("ok   fixture/rows-on-disk");
  } catch (error) {
    failures += 1;
    console.log("FAIL fixture/rows-on-disk");
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
  console.log(`\ndatabase-writes parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndatabase-writes parity: ${total} cases match`);
