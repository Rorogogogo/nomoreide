/**
 * Phase 6 parity gate for the database *connection* routes: list, detect,
 * register, test, remove, and the write-access toggle.
 *
 * These routes decide what a connection string looks like once it leaves the
 * machine, so the gate is mostly about **masking**. A connection URL carries a
 * password, and sometimes carries a second secret in its query string; the
 * listing, the detection scan, and every error message have to lose both. A
 * mask that only handles the password looks completely correct until a URL
 * arrives with `?password=` in it, so those cases are here explicitly.
 *
 * Only SQLite is exercised as a *live* engine -- it needs no server, so the
 * fixture is a file. Postgres and MySQL appear as unreachable connections,
 * where what matters is not the driver's wording but that the secret is gone
 * from it; `secretsNeverAppear` below checks that directly, since two different
 * drivers will never phrase a refusal the same way.
 *
 * Usage:
 *   node --import tsx scripts/check-database-connections-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    "Usage: node --import tsx scripts/check-database-connections-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly form?: string;
  readonly formFor?: (runtime: Runtime) => string;
  readonly pathFor?: (runtime: Runtime) => string;
}

const encode = (value: string) => encodeURIComponent(value);

/** Secrets planted in fixtures; none may survive into any response. */
const SECRETS = ["sup3rs3cret", "querysecret", "tokenvalue", "apikeyvalue", "envpassword"];

const steps: readonly Step[] = [
  // --- the listing, which is where masking is visible -----------------------
  { name: "list/seeded", method: "GET", path: "/api/databases" },

  // --- detection from registered services' .env files -----------------------
  { name: "detect/seeded", method: "GET", path: "/api/databases/detect" },

  // --- register: the form's own refusals ------------------------------------
  { name: "register/no-name", method: "POST", path: "/api/databases", form: "engine=sqlite&url=/tmp/x.db" },
  { name: "register/no-engine", method: "POST", path: "/api/databases", form: "name=x&url=/tmp/x.db" },
  { name: "register/no-url", method: "POST", path: "/api/databases", form: "name=x&engine=sqlite" },
  { name: "register/unknown-engine", method: "POST", path: "/api/databases", form: "name=x&engine=oracle&url=x" },
  { name: "register/empty-engine", method: "POST", path: "/api/databases", form: "name=x&engine=&url=x" },
  // Case matters: the reference compares against a lowercase list.
  { name: "register/engine-wrong-case", method: "POST", path: "/api/databases", form: "name=x&engine=SQLite&url=x" },

  // --- register: the password merge -----------------------------------------
  {
    name: "register/new-postgres-with-password",
    method: "POST",
    path: "/api/databases",
    form: `name=pg&engine=postgres&url=${encode("postgres://user:sup3rs3cret@localhost:5432/app")}`,
  },
  // The client only ever holds the masked URL, so an edit arrives without the
  // password. The stored one must be spliced back in rather than wiped.
  {
    name: "register/edit-postgres-without-password",
    method: "POST",
    path: "/api/databases",
    form: `name=pg&engine=postgres&url=${encode("postgres://user@localhost:5432/renamed")}`,
  },
  { name: "list/after-password-merge", method: "GET", path: "/api/databases" },
  // A freshly supplied password wins over the stored one.
  {
    name: "register/edit-postgres-with-new-password",
    method: "POST",
    path: "/api/databases",
    form: `name=pg&engine=postgres&url=${encode("postgres://user:replaced@localhost:5432/renamed")}`,
  },
  { name: "list/after-password-replace", method: "GET", path: "/api/databases" },
  // SQLite has no password to merge, and its "URL" is a path.
  {
    name: "register/edit-sqlite-keeps-path",
    method: "POST",
    path: "/api/databases",
    formFor: (r) => `name=lite&engine=sqlite&url=${encode(join(r.home, "fixture.db"))}`,
  },
  { name: "list/after-sqlite-edit", method: "GET", path: "/api/databases" },
  // An unparseable URL cannot be spliced; it must survive the attempt.
  {
    name: "register/edit-unparseable-url",
    method: "POST",
    path: "/api/databases",
    form: "name=broken&engine=postgres&url=not%20a%20url",
  },
  // projectPath is authoritative from the client, unlike the password.
  {
    name: "register/sets-project-path",
    method: "POST",
    path: "/api/databases",
    formFor: (r) => `name=pg&engine=postgres&url=${encode("postgres://user@localhost:5432/renamed")}&projectPath=${encode(r.workspace)}`,
  },
  { name: "register/clears-project-path", method: "POST", path: "/api/databases", form: `name=pg&engine=postgres&url=${encode("postgres://user@localhost:5432/renamed")}&projectPath=` },
  { name: "register/blank-project-path", method: "POST", path: "/api/databases", form: `name=pg&engine=postgres&url=${encode("postgres://user@localhost:5432/renamed")}&projectPath=%20%20` },

  // --- what the listing looks like after all that ---------------------------
  { name: "list/after-registrations", method: "GET", path: "/api/databases" },

  // --- test ------------------------------------------------------------------
  { name: "test/no-engine", method: "POST", path: "/api/databases/test", form: "url=x" },
  { name: "test/no-url", method: "POST", path: "/api/databases/test", form: "engine=sqlite" },
  { name: "test/unknown-engine", method: "POST", path: "/api/databases/test", form: "engine=oracle&url=x" },
  {
    name: "test/sqlite-existing-file",
    method: "POST",
    path: "/api/databases/test",
    formFor: (r) => `engine=sqlite&url=${encode(join(r.home, "fixture.db"))}`,
  },
  { name: "list/after-blank-project-path", method: "GET", path: "/api/databases" },
  { name: "list/after-project-path-cleared", method: "GET", path: "/api/databases" },

  // --- write-access toggle ---------------------------------------------------
  { name: "write-access/unlock", method: "POST", path: "/api/databases/lite/write-access", form: "unlocked=true" },
  { name: "write-access/relock", method: "POST", path: "/api/databases/lite/write-access", form: "unlocked=false" },
  // Anything that is not exactly "true" locks.
  { name: "write-access/truthy-but-not-true", method: "POST", path: "/api/databases/lite/write-access", form: "unlocked=1" },
  { name: "write-access/missing-flag", method: "POST", path: "/api/databases/lite/write-access", form: "" },
  { name: "write-access/unknown-connection", method: "POST", path: "/api/databases/nope/write-access", form: "unlocked=true" },
  { name: "write-access/wrong-method", method: "GET", path: "/api/databases/lite/write-access" },

  // Re-registering must carry the unlock state forward.
  { name: "write-access/unlock-before-edit", method: "POST", path: "/api/databases/lite/write-access", form: "unlocked=true" },
  {
    name: "register/edit-keeps-unlock",
    method: "POST",
    path: "/api/databases",
    formFor: (r) => `name=lite&engine=sqlite&url=${encode(join(r.home, "fixture.db"))}`,
  },
  { name: "list/after-unlock-carry", method: "GET", path: "/api/databases" },
  { name: "list/after-unlock-edit", method: "GET", path: "/api/databases" },

  // --- remove ----------------------------------------------------------------
  { name: "remove/wrong-method", method: "PUT", path: "/api/databases/lite" },
  { name: "remove/unknown", method: "DELETE", path: "/api/databases/does-not-exist" },
  { name: "remove/encoded-name", method: "DELETE", path: `/api/databases/${encode("odd name/slash")}` },
  // `pct%20name` double-encoded: decoded once it is the stored name, decoded
  // twice it is `pct name`, which is not registered and removes nothing.
  { name: "remove/name-keeping-an-escape", method: "DELETE", path: "/api/databases/pct%2520name" },
  { name: "remove/existing", method: "DELETE", path: "/api/databases/broken" },
  // The static paths are exact *and method-specific* in the reference, so a
  // method they do not claim falls through to the `:name` pattern and is read
  // as a connection name. A router that matches the static segment first would
  // answer 405 to both of these instead.
  { name: "remove/shadowed-by-detect", method: "DELETE", path: "/api/databases/detect" },
  { name: "remove/shadowed-by-test", method: "DELETE", path: "/api/databases/test" },
  { name: "detect/wrong-method-falls-through", method: "POST", path: "/api/databases/detect", form: "" },
  { name: "list/after-removals", method: "GET", path: "/api/databases" },

  // Required values are trimmed before they are stored, so the padding never
  // reaches the config and a name submitted with spaces is the same name.
  {
    name: "register/whitespace-padded",
    method: "POST",
    path: "/api/databases",
    formFor: (r) => `name=${encode("  spaced  ")}&engine=sqlite&url=${encode(`  ${join(r.home, "fixture.db")}  `)}`,
  },
  { name: "list/after-whitespace-register", method: "GET", path: "/api/databases" },
];

interface Answer {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const body = step.formFor ? step.formFor(runtime) : step.form;
  const path = step.pathFor ? step.pathFor(runtime) : step.path;
  const credential = await credentialOf(runtime);
  // The reference daemon does not write a credential file; only the candidate
  // requires the header, so an absent credential means "send none".
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
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

const credentials = new Map<Runtime, string>();
async function credentialOf(runtime: Runtime): Promise<string> {
  const cached = credentials.get(runtime);
  if (cached) return cached;
  const value = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((text) => text.trim())
    .catch(() => "");
  credentials.set(runtime, value);
  return value;
}

function erase(value: string, runtime: Runtime): string {
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

function normalize(answer: Answer, runtime: Runtime): Answer {
  return { ...answer, body: JSON.parse(erase(JSON.stringify(answer.body), runtime)) };
}

/**
 * Every fixture secret, in every response, from both runtimes.
 *
 * `detect` is exempt, and only `detect`. It hands back the **unmasked** URL
 * next to the masked one on purpose -- the client needs the real string to
 * register the connection it just found, and has nowhere else to get it. Every
 * other route deals in connections the server already stores, so it has no
 * reason to say a password out loud.
 */
function secretsNeverAppear(label: string, answer: Answer): string[] {
  if (label.startsWith("detect/")) return [];
  const rendered = JSON.stringify(answer.body ?? "");
  return SECRETS.filter((secret) => rendered.includes(secret)).map(
    (secret) => `${label} leaked ${secret}`,
  );
}

async function seedFixtures(runtime: Runtime): Promise<void> {
  // A real SQLite file, so `test` has something that genuinely opens.
  const fixture = join(runtime.home, "fixture.db");
  await writeFile(fixture, "");

  // Two services with .env files for the detection scan to walk.
  const api = join(runtime.workspace, "api");
  const web = join(runtime.workspace, "web");
  await mkdir(api, { recursive: true });
  await mkdir(web, { recursive: true });
  await writeFile(
    join(api, ".env"),
    [
      "# a comment line",
      "",
      "DATABASE_URL=postgres://user:envpassword@localhost:5432/api",
      'QUOTED_URL="mysql://root:envpassword@127.0.0.1:3306/shop"',
      "SINGLE_QUOTED='mariadb://root@127.0.0.1:3306/legacy'",
      "SQLITE_PATH=./data/app.sqlite3",
      "FILE_URL=file:./data/other.db",
      // Classified only by the `file:` branch: the extension fallback cannot
      // reach it, because the query suffix means it does not end in `.db`.
      "FILE_URL_WITH_QUERY=file:./data/third.db?mode=ro",
      "NOT_A_URL=hello world",
      "PORT=3000",
      "malformed line without equals",
      "lowercase_key=postgres://user@localhost:5432/lower",
      "DUPLICATE_URL=postgres://user:envpassword@localhost:5432/api",
    ].join("\n"),
  );
  // The same URL from a second service is still a duplicate.
  await writeFile(
    join(web, ".env"),
    ["SHARED=postgres://user:envpassword@localhost:5432/api", "WEB_DB=sqlite://./web.db"].join("\n"),
  );
  // A service whose cwd has no .env at all, and one with no cwd.
  await mkdir(join(runtime.workspace, "empty"), { recursive: true });
}

const root = await mkdtemp(join(tmpdir(), "nmi-db-conn-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;
const leaks: string[] = [];

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      (partial) => ({
        version: 1,
        services: [
          { name: "api", command: "true", cwd: join(partial.workspace, "api") },
          { name: "web", command: "true", cwd: join(partial.workspace, "web") },
          { name: "empty", command: "true", cwd: join(partial.workspace, "empty") },
        ],
        bundles: [],
        databases: [
          { name: "lite", engine: "sqlite", url: join(partial.home, "fixture.db") },
          {
            name: "pg-plain",
            engine: "postgres",
            url: "postgres://user:sup3rs3cret@localhost:5432/app",
          },
          // The case a password-only mask misses entirely.
          {
            name: "pg-query-secret",
            engine: "postgres",
            url: "postgres://user@localhost:5432/app?sslmode=require&password=querysecret",
          },
          {
            name: "pg-many-secrets",
            engine: "postgres",
            url: "postgres://user@localhost:5432/app?token=tokenvalue&api_key=apikeyvalue&apiKey=apikeyvalue&passwd=querysecret&secret=querysecret&keep=visible",
          },
          { name: "mysql-plain", engine: "mysql", url: "mysql://root:sup3rs3cret@127.0.0.1:3306/shop" },
          // Unparseable: masked by its edges, not by URL surgery.
          { name: "odd name/slash", engine: "postgres", url: "this-is-not-a-url-at-all" },
          // Survives one decode with an escape still in it, so a second decode
          // would turn it into a different name and miss.
          { name: "pct%20name", engine: "postgres", url: "postgres://user@localhost:5432/pct" },
          { name: "short-url", engine: "postgres", url: "abc" },
          { name: "eight-chars", engine: "postgres", url: "12345678" },
          { name: "nine-chars", engine: "postgres", url: "123456789" },
          { name: "unlocked-already", engine: "sqlite", url: join(partial.home, "fixture.db"), writeUnlocked: true },
          { name: "with-project", engine: "sqlite", url: join(partial.home, "fixture.db"), projectPath: partial.workspace },
        ],
        gitRepositories: [],
      }),
      () => [],
    );
    await seedFixtures(runtime);
    await harness.startDaemon(runtime, {});
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  for (const step of steps) {
    const answers = {
      reference: await send(reference, step),
      candidate: await send(candidate, step),
    };
    leaks.push(...secretsNeverAppear(`${step.name}/reference`, answers.reference));
    leaks.push(...secretsNeverAppear(`${step.name}/candidate`, answers.candidate));
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

  // What each runtime actually saved. A response that echoes the right shape
  // while storing a wiped password would pass every step above.
  const stored = async (runtime: Runtime) =>
    JSON.parse(erase(await readFile(join(runtime.home, ".config", "nomoreide", "config.json"), "utf8"), runtime));
  const both = { reference: await stored(reference), candidate: await stored(candidate) };
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
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

for (const leak of leaks) {
  failures += 1;
  console.log(`FAIL ${leak}`);
}

const total = steps.length + 1;
if (failures > 0) {
  console.log(`\ndatabase-connections parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndatabase-connections parity: ${total} cases match`);
