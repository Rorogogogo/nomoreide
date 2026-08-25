/**
 * Phase 6 parity gate for the database *catalog read* routes: capabilities,
 * schemas, objects, details, catalog rows, tables, plain rows, and query.
 *
 * SQLite is the only engine a fixture can stand up honestly -- it needs no
 * server -- and it reaches everything in these routes that is not dialect: the
 * catalog shapes, the opaque object key, how a row becomes JSON, where the row
 * cap lands, which columns get bulleted out, and how a filter or sort the
 * client invented is refused. Postgres appears only where the answer is
 * engine-derived rather than fetched (`capabilities`), because a driver's
 * wording on an unreachable host is not diffable and matching it would be
 * matching the wrong thing.
 *
 * Two routes deliberately differ from each other and both are gated here:
 * `catalog/rows` bullets out a column whose *name* looks like a secret, and
 * plain `rows` does not. That is the reference's behaviour, not an oversight to
 * unify.
 *
 * Object keys are opaque, so the gate does not construct them -- it reads each
 * runtime's own key out of its own `catalog/objects` listing, the way the
 * client does. The listing itself is a compared step, so a runtime that
 * invented a different key still fails.
 *
 * Usage:
 *   node --import tsx scripts/check-database-catalog-parity.ts <candidate> [args...]
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
    "Usage: node --import tsx scripts/check-database-catalog-parity.ts [--dump] <candidate> [args...]",
  );
}

/** A catalog object's opaque key, as that runtime reported it. */
type Keys = (label: string) => string;

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path?: string;
  readonly pathFor?: (keys: Keys) => string;
  readonly form?: string;
}

const encode = (value: string) => encodeURIComponent(value);
const q = (value: unknown) => encode(JSON.stringify(value));

/** The fixture schema, identical in both runtimes' homes. */
const SCHEMA: readonly string[] = [
  "CREATE TABLE authors (id INTEGER NOT NULL, tenant TEXT NOT NULL, name TEXT, PRIMARY KEY (id, tenant), UNIQUE (id))",
  "CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE, isbn TEXT UNIQUE, pages INTEGER CHECK (pages > 0), title TEXT NOT NULL DEFAULT 'untitled')",
  "CREATE UNIQUE INDEX books_isbn_idx ON books(isbn) WHERE isbn IS NOT NULL",
  "CREATE INDEX books_author_idx ON books(author_id, pages DESC)",
  "CREATE TRIGGER books_touch AFTER UPDATE ON books BEGIN SELECT 1; END",
  "CREATE VIEW v_books AS SELECT id, title FROM books",
  'CREATE TABLE "weird name" (a INT)',
  // Sensitive-looking column names, which one of the two row routes bullets out.
  "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, api_token TEXT, secret TEXT, age INTEGER)",
  // Every SQLite storage class, so the JSON conversion is exercised.
  "CREATE TABLE cells (i INTEGER, r REAL, t TEXT, b BLOB, n INTEGER)",
  // Values a LIKE filter has to escape rather than interpret.
  "CREATE TABLE patterns (id INTEGER PRIMARY KEY, label TEXT)",
  "INSERT INTO authors VALUES (1,'acme','Ada'), (2,'acme','Bo')",
  "INSERT INTO books (author_id, isbn, pages, title) VALUES (1,'x',10,'First'), (2,'y',20,'Second'), (1,NULL,30,'Third'), (2,'z',40,'Fourth')",
  "INSERT INTO users VALUES (1,'a@b.c','hunter2','tok','shh',30), (2,'d@e.f',NULL,NULL,NULL,17), (3,'g@h.i','x','y','z',40)",
  "INSERT INTO cells VALUES (42, 1.5, 'hi', x'00ff10', NULL)",
  "INSERT INTO patterns (label) VALUES ('100%'), ('a_b'), ('plain'), ('with!bang')",
];

const steps: readonly Step[] = [
  // --- capabilities: engine-derived, so postgres answers without a server ----
  { name: "capabilities/sqlite", method: "GET", path: "/api/databases/demo/catalog/capabilities" },
  { name: "capabilities/postgres", method: "GET", path: "/api/databases/pg/catalog/capabilities" },
  { name: "capabilities/unknown-connection", method: "GET", path: "/api/databases/nope/catalog/capabilities" },
  { name: "capabilities/wrong-method", method: "POST", path: "/api/databases/demo/catalog/capabilities" },
  { name: "capabilities/encoded-name", method: "GET", path: `/api/databases/${encode("odd name")}/catalog/capabilities` },

  // --- schemas ---------------------------------------------------------------
  { name: "schemas/sqlite", method: "GET", path: "/api/databases/demo/catalog/schemas" },
  { name: "schemas/empty-file", method: "GET", path: "/api/databases/blank/catalog/schemas" },
  { name: "schemas/unknown-connection", method: "GET", path: "/api/databases/nope/catalog/schemas" },
  { name: "schemas/wrong-method", method: "DELETE", path: "/api/databases/demo/catalog/schemas" },

  // --- objects ---------------------------------------------------------------
  { name: "objects/main", method: "GET", path: "/api/databases/demo/catalog/objects?schema=main" },
  { name: "objects/missing-schema", method: "GET", path: "/api/databases/demo/catalog/objects" },
  { name: "objects/empty-schema", method: "GET", path: "/api/databases/demo/catalog/objects?schema=" },
  { name: "objects/unknown-schema", method: "GET", path: "/api/databases/demo/catalog/objects?schema=elsewhere" },
  { name: "objects/repeated-schema-param", method: "GET", path: "/api/databases/demo/catalog/objects?schema=main&schema=other" },
  { name: "objects/unknown-connection", method: "GET", path: "/api/databases/nope/catalog/objects?schema=main" },
  { name: "objects/wrong-method", method: "POST", path: "/api/databases/demo/catalog/objects?schema=main" },

  // --- details ---------------------------------------------------------------
  { name: "details/table", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/details?key=${encode(k("table:books"))}` },
  { name: "details/composite-key-table", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/details?key=${encode(k("table:authors"))}` },
  { name: "details/view", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/details?key=${encode(k("view:v_books"))}` },
  { name: "details/quoted-name", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/details?key=${encode(k("table:weird name"))}` },
  { name: "details/every-storage-class", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/details?key=${encode(k("table:cells"))}` },
  { name: "details/missing-key", method: "GET", path: "/api/databases/demo/catalog/details" },
  { name: "details/empty-key", method: "GET", path: "/api/databases/demo/catalog/details?key=" },
  { name: "details/undecodable-key", method: "GET", path: "/api/databases/demo/catalog/details?key=not-a-key" },
  { name: "details/well-formed-unknown-key", method: "GET", path: `/api/databases/demo/catalog/details?key=${encode(Buffer.from(JSON.stringify({ schema: "main", name: "ghost", kind: "table" })).toString("base64url"))}` },
  // A key naming a schema this connection does not have must answer the same
  // sentence, not one that confirms which schemas exist.
  { name: "details/key-naming-an-unknown-schema", method: "GET", path: `/api/databases/demo/catalog/details?key=${encode(Buffer.from(JSON.stringify({ schema: "elsewhere", name: "books", kind: "table" })).toString("base64url"))}` },
  { name: "catalog-rows/key-naming-an-unknown-schema", method: "GET", path: `/api/databases/demo/catalog/rows?key=${encode(Buffer.from(JSON.stringify({ schema: "elsewhere", name: "books", kind: "table" })).toString("base64url"))}` },
  { name: "details/wrong-method", method: "POST", path: "/api/databases/demo/catalog/details?key=x" },

  // --- catalog rows: the browser's own row reader ----------------------------
  { name: "catalog-rows/default-limit", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}` },
  { name: "catalog-rows/explicit-limit", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&limit=2` },
  { name: "catalog-rows/limit-and-offset", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&limit=2&offset=2` },
  { name: "catalog-rows/offset-past-end", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&offset=99` },
  { name: "catalog-rows/limit-zero", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&limit=0` },
  { name: "catalog-rows/limit-negative", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&limit=-5` },
  { name: "catalog-rows/limit-not-a-number", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&limit=many` },
  { name: "catalog-rows/limit-above-cap", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&limit=99999` },
  { name: "catalog-rows/offset-negative", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&offset=-3` },
  { name: "catalog-rows/offset-not-a-number", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&offset=later` },
  // A column whose name looks like a secret is bulleted out here.
  { name: "catalog-rows/masks-secret-columns", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:users"))}` },
  { name: "catalog-rows/view", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("view:v_books"))}` },
  { name: "catalog-rows/quoted-name", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:weird name"))}` },
  { name: "catalog-rows/every-storage-class", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:cells"))}` },
  { name: "catalog-rows/missing-key", method: "GET", path: "/api/databases/demo/catalog/rows" },
  { name: "catalog-rows/undecodable-key", method: "GET", path: "/api/databases/demo/catalog/rows?key=not-a-key" },
  { name: "catalog-rows/wrong-method", method: "POST", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}` },

  // --- catalog rows: filters -------------------------------------------------
  // Doubles as the paging-stability case: SQLite serves this one from
  // `books_author_idx (author_id, pages DESC)`, so the rows arrive in index
  // order unless the primary key is appended to the sort.
  { name: "filters/eq", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "author_id", operator: "eq", value: "1" }])}` },
  { name: "filters/neq", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "author_id", operator: "neq", value: "1" }])}` },
  { name: "filters/gt-lte", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "pages", operator: "gt", value: "10" }, { column: "pages", operator: "lte", value: "30" }])}` },
  { name: "filters/is-null", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "isbn", operator: "isNull" }])}` },
  { name: "filters/is-not-null", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "isbn", operator: "isNotNull" }])}` },
  { name: "filters/contains", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "title", operator: "contains", value: "ir" }])}` },
  { name: "filters/starts-with", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "title", operator: "startsWith", value: "F" }])}` },
  { name: "filters/ends-with", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "title", operator: "endsWith", value: "d" }])}` },
  // A wildcard in the *value* is a literal, not a pattern.
  { name: "filters/contains-percent", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:patterns"))}&filters=${q([{ column: "label", operator: "contains", value: "%" }])}` },
  { name: "filters/contains-underscore", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:patterns"))}&filters=${q([{ column: "label", operator: "contains", value: "_" }])}` },
  { name: "filters/contains-escape-char", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:patterns"))}&filters=${q([{ column: "label", operator: "contains", value: "!" }])}` },
  { name: "filters/quote-in-value", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "title", operator: "eq", value: "O'Reilly" }])}` },
  { name: "filters/unknown-column", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "nope", operator: "eq", value: "1" }])}` },
  { name: "filters/unknown-operator", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "pages", operator: "between", value: "1" }])}` },
  { name: "filters/missing-value", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([{ column: "pages", operator: "eq" }])}` },
  { name: "filters/too-many", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q(Array.from({ length: 9 }, () => ({ column: "pages", operator: "gt", value: "0" })))}` },
  { name: "filters/not-json", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=oops` },
  // A document that runs out *inside* a container is deliberately absent: see
  // the boundary recorded in `server/js_json.rs`. `[1,` below is the truncation
  // both runtimes do answer the same way.
  { name: "filters/truncated-json", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${encode("[1,")}` },
  { name: "filters/trailing-junk", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${encode("[1] x")}` },
  { name: "filters/unterminated-string", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${encode("[\"a")}` },
  { name: "filters/missing-comma", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${encode("[1,\"a\"o]")}` },
  { name: "filters/unquoted-key", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${encode("{a:1}")}` },
  // Past twenty characters the message shows a window instead of the whole
  // document, with an ellipsis on the end it does not reach.
  { name: "filters/long-junk", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${encode("x".repeat(40))}` },
  { name: "filters/junk-late-in-a-long-document", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${encode(`[${"1,".repeat(20)}@]`)}` },
  { name: "filters/json-but-not-array", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q({ column: "pages" })}` },
  { name: "filters/empty-array", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&filters=${q([])}` },

  // --- catalog rows: sort ----------------------------------------------------
  { name: "sort/asc", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&sortColumn=title&sortDirection=asc` },
  { name: "sort/desc", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&sortColumn=title&sortDirection=desc` },
  { name: "sort/column-without-direction", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&sortColumn=title` },
  { name: "sort/direction-without-column", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&sortDirection=desc` },
  { name: "sort/invalid-direction", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&sortColumn=title&sortDirection=sideways` },
  { name: "sort/unknown-column", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&sortColumn=nope&sortDirection=asc` },
  // The primary key is appended so paging is stable; sorting *by* it must not
  // append it twice.
  { name: "sort/by-primary-key", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:books"))}&sortColumn=id&sortDirection=desc` },
  { name: "sort/table-without-primary-key", method: "GET", pathFor: (k) => `/api/databases/demo/catalog/rows?key=${encode(k("table:cells"))}&sortColumn=i&sortDirection=desc` },

  // --- tables ----------------------------------------------------------------
  { name: "tables/demo", method: "GET", path: "/api/databases/demo/tables" },
  { name: "tables/empty-file", method: "GET", path: "/api/databases/blank/tables" },
  { name: "tables/unknown-connection", method: "GET", path: "/api/databases/nope/tables" },
  { name: "tables/wrong-method", method: "POST", path: "/api/databases/demo/tables" },

  // --- plain rows ------------------------------------------------------------
  { name: "rows/basic", method: "GET", path: "/api/databases/demo/rows?table=books" },
  { name: "rows/limit-and-offset", method: "GET", path: "/api/databases/demo/rows?table=books&limit=2&offset=1" },
  { name: "rows/limit-zero", method: "GET", path: "/api/databases/demo/rows?table=books&limit=0" },
  { name: "rows/limit-negative", method: "GET", path: "/api/databases/demo/rows?table=books&limit=-1" },
  { name: "rows/limit-not-a-number", method: "GET", path: "/api/databases/demo/rows?table=books&limit=lots" },
  { name: "rows/offset-negative", method: "GET", path: "/api/databases/demo/rows?table=books&offset=-1" },
  // The route that does *not* bullet out a secret-looking column.
  { name: "rows/keeps-secret-columns", method: "GET", path: "/api/databases/demo/rows?table=users" },
  { name: "rows/limit-above-cap", method: "GET", path: "/api/databases/demo/rows?table=books&limit=99999" },
  { name: "rows/every-storage-class", method: "GET", path: "/api/databases/demo/rows?table=cells" },
  { name: "rows/view", method: "GET", path: "/api/databases/demo/rows?table=v_books" },
  { name: "rows/quoted-name", method: "GET", path: `/api/databases/demo/rows?table=${encode("weird name")}` },
  { name: "rows/missing-table", method: "GET", path: "/api/databases/demo/rows" },
  { name: "rows/empty-table", method: "GET", path: "/api/databases/demo/rows?table=" },
  { name: "rows/unknown-table", method: "GET", path: "/api/databases/demo/rows?table=ghost" },
  { name: "rows/unknown-connection", method: "GET", path: "/api/databases/nope/rows?table=books" },
  { name: "rows/wrong-method", method: "POST", path: "/api/databases/demo/rows?table=books" },

  // --- query -----------------------------------------------------------------
  { name: "query/select", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT id, title FROM books ORDER BY id")}` },
  { name: "query/select-with-limit", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT id FROM books ORDER BY id")}&limit=2` },
  { name: "query/limit-zero", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT id FROM books")}&limit=0` },
  { name: "query/limit-negative", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT id FROM books")}&limit=-2` },
  { name: "query/limit-not-a-number", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT id FROM books")}&limit=some` },
  { name: "query/limit-blank", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT id FROM books")}&limit=` },
  { name: "query/no-rows", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT id FROM books WHERE 0")}` },
  { name: "query/expression-columns", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT 1 + 1, 'x' AS labelled, NULL")}` },
  { name: "query/missing-sql", method: "POST", path: "/api/databases/demo/query", form: "limit=5" },
  { name: "query/empty-sql", method: "POST", path: "/api/databases/demo/query", form: "sql=" },
  { name: "query/blank-sql", method: "POST", path: "/api/databases/demo/query", form: "sql=%20%20" },
  { name: "query/syntax-error", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELEKT 1")}` },
  { name: "query/unknown-table", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT * FROM ghost")}` },
  { name: "query/insert-is-refused", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("INSERT INTO books (author_id, title) VALUES (1, 'nope')")}` },
  { name: "query/update-is-refused", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("UPDATE books SET title = 'nope'")}` },
  { name: "query/drop-is-refused", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("DROP TABLE books")}` },
  { name: "query/pragma", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("PRAGMA user_version")}` },
  { name: "query/trailing-semicolon", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT 1;")}` },
  { name: "query/trailing-semicolon-and-space", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT 1 ;  ")}` },
  // Only *one* semicolon is dropped, so this stays two statements.
  { name: "query/two-trailing-semicolons", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT 1;;")}` },
  { name: "query/only-a-semicolon", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode(";")}` },
  { name: "query/unknown-connection", method: "POST", path: "/api/databases/nope/query", form: `sql=${encode("SELECT 1")}` },
  { name: "query/wrong-method", method: "GET", path: "/api/databases/demo/query" },
  { name: "query/secret-column-is-not-masked", method: "POST", path: "/api/databases/demo/query", form: `sql=${encode("SELECT password_hash FROM users ORDER BY id")}` },

  // --- the fixture is untouched by every read above --------------------------
  { name: "final/rows-unchanged", method: "GET", path: "/api/databases/demo/rows?table=books" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

async function send(runtime: Runtime, step: Step, keys: Keys): Promise<Answer> {
  const path = step.pathFor ? step.pathFor(keys) : (step.path as string);
  const credential = await credentialOf(runtime);
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  if (step.form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
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
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
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

/**
 * Each runtime's own object keys, read out of its own listing.
 *
 * The key is opaque by design, so nothing here builds one: a client gets keys
 * from `catalog/objects` and hands them back unread, and so does the gate. The
 * listing is compared as a step of its own, so a runtime that invents a
 * different key is caught there rather than silently here.
 */
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

const root = await mkdtemp(join(tmpdir(), "nmi-db-catalog-parity-"));
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
          { name: "demo", engine: "sqlite", url: join(partial.home, "demo.db") },
          { name: "blank", engine: "sqlite", url: join(partial.home, "blank.db") },
          { name: "odd name", engine: "sqlite", url: join(partial.home, "demo.db") },
          // Never reachable; only its engine-derived answers are compared.
          { name: "pg", engine: "postgres", url: "postgres://user:pw@127.0.0.1:1/none" },
        ],
        gitRepositories: [],
      }),
      () => [],
    );
    seedDatabase(join(runtime.home, "demo.db"), SCHEMA);
    seedDatabase(join(runtime.home, "blank.db"), []);
    await harness.startDaemon(runtime, {});
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;
  const keys = {
    reference: await keysOf(reference),
    candidate: await keysOf(candidate),
  };

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
  console.log(`\ndatabase-catalog parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndatabase-catalog parity: ${steps.length} cases match`);
