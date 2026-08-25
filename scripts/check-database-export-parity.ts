/**
 * Phase 6 parity gate for `catalog/export`, the database domain's last route
 * and the only one that answers with a **file** rather than a payload.
 *
 * That makes it the only gate here that compares bytes. An export is saved and
 * opened somewhere else, so every part of it is the payload: the CSV's CRLF
 * line endings, the JSON's trailing newline, and the `content-disposition`
 * filename a browser writes to disk. All of them are compared exactly.
 *
 * The fixture is built out of the values a CSV gets wrong:
 *
 *  - A cell that opens with `=`, `+`, `-`, `@`, a tab, or a carriage return is
 *    a **formula** to a spreadsheet, so it is prefixed with an apostrophe --
 *    but only when it arrived as a string. A negative *number* is a number,
 *    and `signed` versus `typed` in the fixture is that pair.
 *  - Commas, quotes, and newlines force quoting, and a quote inside doubles.
 *  - A column whose *name* looks like a secret is bulleted out, the same as in
 *    the row browser.
 *  - Bytes reach both formats as the index-keyed object a `Uint8Array` becomes
 *    under `JSON.stringify`, and the reference sorts those keys as *text* --
 *    so a blob long enough to have a `"10"` orders it before `"2"`.
 *
 * Usage:
 *   node --import tsx scripts/check-database-export-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-database-export-parity.ts [--dump] <candidate> [args...]",
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
     (1,'plain',1.5,x'000102030405060708090a0b',NULL,'tok',-5,'-5'),
     (2,'has,comma',2,NULL,'x','tok2',0,'+1'),
     (3,'has""quote',3,NULL,'y',NULL,1,'@home'),
     (4,'=formula',4,NULL,'z','tok4',2,'  =late'),
     (5,'multi
line',5,NULL,NULL,'tok5',3,'	tabbed')`,
  // The spellings JavaScript and Rust disagree about: a whole float, a negative
  // zero, and numbers past where the notation changes.
  "CREATE TABLE numbers (id INTEGER PRIMARY KEY, value REAL)",
  "INSERT INTO numbers VALUES (1, 2.0), (2, -0.0), (3, 1e21), (4, 1e-7), (5, 0.1), (6, -3.0), (7, 1e20)",
  "CREATE TABLE empty_export (id INTEGER PRIMARY KEY, only TEXT)",
  "CREATE VIEW v_catalogue AS SELECT id, title FROM catalogue",
  "CREATE TABLE composite (a INTEGER NOT NULL, b TEXT NOT NULL, payload TEXT, PRIMARY KEY (a, b))",
  "INSERT INTO composite VALUES (1,'x','first'), (1,'y','second'), (2,'x','third')",
  "CREATE TABLE no_primary_key (a INTEGER, b TEXT)",
  "INSERT INTO no_primary_key VALUES (1,'x'), (2,'y')",
];

const steps: readonly Step[] = [
  { name: "export/csv", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=csv&key=${encode(k("table:catalogue"))}`, raw: true, headers: ["content-type", "content-disposition", "cache-control", "x-content-type-options"] },
  { name: "export/json", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=json&key=${encode(k("table:catalogue"))}`, raw: true, headers: ["content-type", "content-disposition", "cache-control", "x-content-type-options"] },
  { name: "export/empty-table-csv", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=csv&key=${encode(k("table:empty_export"))}`, raw: true, headers: ["content-type", "content-disposition"] },
  { name: "export/empty-table-json", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=json&key=${encode(k("table:empty_export"))}`, raw: true, headers: ["content-type", "content-disposition"] },
  { name: "export/view-csv", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=csv&key=${encode(k("view:v_catalogue"))}`, raw: true, headers: ["content-disposition"] },
  // The filename is built from names a person chose, so it has to survive one.
  { name: "export/filename-from-an-odd-connection-name", method: "GET", pathFor: (k) => `/api/databases/${encode("odd name/slash")}/catalog/export?format=csv&key=${encode(k("table:catalogue"))}`, raw: true, headers: ["content-disposition"] },
  { name: "export/missing-key", method: "GET", path: "/api/databases/demo/catalog/export?format=csv" },
  { name: "export/empty-key", method: "GET", path: "/api/databases/demo/catalog/export?format=csv&key=" },
  { name: "export/missing-format", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?key=${encode(k("table:catalogue"))}` },
  { name: "export/unknown-format", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=xlsx&key=${encode(k("table:catalogue"))}` },
  { name: "export/format-wrong-case", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=CSV&key=${encode(k("table:catalogue"))}` },
  { name: "export/undecodable-key", method: "GET", path: "/api/databases/demo/catalog/export?format=csv&key=not-a-key" },
  { name: "export/unknown-connection", method: "GET", pathFor: (k) => `/api/databases/nope/catalog/export?format=csv&key=${encode(k("table:catalogue"))}` },
  { name: "export/wrong-method", method: "POST", path: "/api/databases/demo/catalog/export?format=csv&key=x" },
  { name: "export/numbers-csv", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=csv&key=${encode(k("table:numbers"))}`, raw: true },
  { name: "export/numbers-json", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=json&key=${encode(k("table:numbers"))}`, raw: true },
  { name: "export/composite-key-table-csv", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=csv&key=${encode(k("table:composite"))}`, raw: true, headers: ["content-disposition"] },
  // No primary key, so the ordering falls back to every column -- which is the
  // only thing making the row order of an export repeatable.
  { name: "export/table-without-a-primary-key-csv", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=csv&key=${encode(k("table:no_primary_key"))}`, raw: true },
  { name: "export/table-without-a-primary-key-json", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=json&key=${encode(k("table:no_primary_key"))}`, raw: true },
  { name: "export/view-json", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=json&key=${encode(k("view:v_catalogue"))}`, raw: true },
  { name: "export/key-naming-an-unknown-schema", method: "GET", path: `/api/databases/demo/catalog/export?format=csv&key=${encode(Buffer.from(JSON.stringify({ schema: "elsewhere", name: "catalogue", kind: "table" })).toString("base64url"))}` },
  { name: "export/repeated-format-param", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/export?format=csv&format=json&key=${encode(k("table:catalogue"))}`, raw: true, headers: ["content-type"] },
  { name: "export/locked-connection", method: "GET", pathFor: (k) => `/api/databases/locked/catalog/export?format=csv&key=${encode(k("table:catalogue"))}`, raw: true, headers: ["content-disposition"] },
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

const root = await mkdtemp(join(tmpdir(), "nmi-db-export-parity-"));
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

} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\ndatabase-export parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndatabase-export parity: ${steps.length} cases match`);
