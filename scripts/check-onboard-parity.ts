/**
 * Phase 6 parity gate for the "Add from GitHub" wizard:
 *
 *   POST /api/onboard/scan
 *   POST /api/onboard/register
 *
 * (The third endpoint, `/api/onboard/install/stream`, is Server-Sent Events and
 * is not served natively yet, so nothing here drives it.)
 *
 * **Everything is a 422 except two guards.** Each route has one 400 — a missing
 * `url`, and a `name`/`cwd` pair that is not an onboarded path — and wraps the
 * whole rest of its work in a single `try`. A URL that does not parse, a clone
 * git refused, a schema refusal and a port conflict raised while starting the
 * new service all come back as 422 with the message alone. That is why so many
 * cases here are about *wording*: the status says almost nothing.
 *
 * **The clone is real, and hermetic.** The fixture builds two git repositories
 * in the shared temp root and both runtimes clone them over `file://`, so a
 * scan exercises `git clone --depth 1` and the whole profile/proposal pipeline
 * without touching the network. The source lives outside both homes, so its
 * path is identical on both sides and needs no normalization; the clone lands
 * under each runtime's own home and is erased to `<home>`.
 *
 * **The containment guard is textual, not structural.** `isInsideReposDir` is
 * `relative(...)` plus `startsWith("..")`, so `..hidden` — a legitimate
 * directory name — is refused, a `..` segment that escapes is refused, and the
 * repos directory itself is refused because the relative path is empty. None of
 * those consult the filesystem, which is why the cases can name paths that are
 * not there.
 *
 * **Two of the three writes are best-effort.** Registering the service is the
 * operation; also listing the clone in the Git tab and registering the database
 * that rode along are conveniences whose failures are swallowed. So they cannot
 * be observed in a response at all — the cases that read the config file on
 * disk are what make them visible.
 *
 * Usage:
 *   node --import tsx scripts/check-onboard-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const run = promisify(execFile);

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-onboard-parity.ts [--dump] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  readonly method?: "GET" | "POST";
  /** The endpoint to drive; omitted for the two steps that read state. */
  readonly path?: string;
  /** JSON body, with `{{HOME}}` and `{{SOURCE}}` resolved per runtime. */
  readonly body?: string;
  /** Read the config file on disk rather than sending a request. */
  readonly config?: true;
  /** Keys replaced before diffing. */
  readonly redact?: readonly string[];
}

const SCAN = "/api/onboard/scan";
const REGISTER = "/api/onboard/register";
/** Where a scan puts its clones, relative to a runtime's home. */
const REPOS = "{{HOME}}/.nomoreide/repos";

const steps: readonly Step[] = [
  // --- scan: the one guard ---------------------------------------------------
  { name: "scan/an-empty-body", path: SCAN, body: "" },
  { name: "scan/no-url", path: SCAN, body: "{}" },
  { name: "scan/a-blank-url", path: SCAN, body: '{"url":"   "}' },
  // Trimmed before it is judged, so whitespace around a real URL is fine.
  { name: "scan/a-url-that-is-a-number", path: SCAN, body: '{"url":42}' },
  { name: "scan/a-url-that-is-null", path: SCAN, body: '{"url":null}' },
  { name: "scan/a-body-that-is-an-array", path: SCAN, body: '["{{SOURCE}}/demo-app"]' },

  // --- scan: URLs that do not name a repository ------------------------------
  { name: "scan/not-a-url", path: SCAN, body: '{"url":"just some text"}' },
  { name: "scan/an-unsupported-scheme", path: SCAN, body: '{"url":"ftp://example.com/a/b.git"}' },
  { name: "scan/a-url-with-no-path", path: SCAN, body: '{"url":"https://github.com"}' },
  { name: "scan/a-url-whose-name-sanitizes-away", path: SCAN, body: '{"url":"https://github.com/owner/---.git"}' },
  { name: "scan/an-scp-style-url", path: SCAN, body: '{"url":"git@github.com:owner/nothing-here.git"}' },

  // --- scan: a clone that fails ----------------------------------------------
  { name: "scan/a-directory-that-is-not-a-repository", path: SCAN, body: '{"url":"file://{{SOURCE}}/not-a-repo"}' },
  { name: "scan/a-path-that-is-not-there", path: SCAN, body: '{"url":"file://{{SOURCE}}/no-such-thing"}' },

  // --- scan: the real thing --------------------------------------------------
  { name: "scan/a-repository", path: SCAN, body: '{"url":"file://{{SOURCE}}/demo-app"}' },
  // Same clone path, now non-empty, so the destination guard fires.
  { name: "scan/the-same-repository-again", path: SCAN, body: '{"url":"file://{{SOURCE}}/demo-app"}' },
  // A `.git` suffix names the same repository and sanitizes to the same
  // directory, so this is refused for the same reason rather than re-cloned.
  { name: "scan/the-same-repository-with-a-git-suffix", path: SCAN, body: '{"url":"file://{{SOURCE}}/demo-app.git"}' },
  { name: "scan/a-repository-with-no-signals", path: SCAN, body: '{"url":"file://{{SOURCE}}/plain-repo"}' },
  { name: "scan/wrong-method", method: "GET", path: SCAN, body: "" },

  // --- register: the guard ---------------------------------------------------
  { name: "register/an-empty-body", path: REGISTER, body: "{}" },
  { name: "register/no-cwd", path: REGISTER, body: '{"name":"demo"}' },
  { name: "register/a-name-that-is-a-number", path: REGISTER, body: `{"name":1,"cwd":"${REPOS}/demo-app"}` },
  { name: "register/a-cwd-that-is-a-number", path: REGISTER, body: '{"name":"demo","cwd":7}' },
  { name: "register/a-cwd-outside-the-repos-dir", path: REGISTER, body: '{"name":"demo","cwd":"{{HOME}}/workspace"}' },
  { name: "register/the-repos-dir-itself", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}"}` },
  { name: "register/a-cwd-that-escapes-with-dot-dot", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app/../../../workspace","command":"node -v"}` },
  { name: "register/a-cwd-that-is-relative", path: REGISTER, body: '{"name":"demo","cwd":"demo-app","command":"node -v"}' },
  { name: "register/a-cwd-with-a-null-byte", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app\\u0000","command":"node -v"}` },
  // A directory whose *name* begins with `..`, which the string check refuses
  // even though it is inside. Nothing has to exist for this to be decided.
  { name: "register/a-cwd-named-dot-dot-something", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/..hidden","command":"node -v"}` },
  // Inside, so the guard passes and the *next* refusal is the one reported.
  { name: "register/a-cwd-that-is-not-there", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app/nope"}` },

  // --- register: what the proposal has to say --------------------------------
  { name: "register/no-command", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app"}` },
  { name: "register/a-blank-command", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"   "}` },
  { name: "register/a-command-that-is-a-number", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":8080}` },
  { name: "register/a-blank-name", path: REGISTER, body: `{"name":"","cwd":"${REPOS}/demo-app","command":"node -v"}` },
  { name: "register/compose-without-a-service", path: REGISTER, body: `{"name":"demo","kind":"docker-compose","cwd":"${REPOS}/demo-app"}` },
  { name: "register/compose-with-a-blank-service", path: REGISTER, body: `{"name":"demo","kind":"docker-compose","cwd":"${REPOS}/demo-app","composeService":"  "}` },
  // Not a kind this route knows, so it is built as a *local* service — and a
  // local service has no `host`, so the missing `command` is what is reported.
  { name: "register/an-ssh-kind-without-a-command", path: REGISTER, body: `{"name":"demo","kind":"ssh","cwd":"${REPOS}/demo-app","host":"box"}` },
  { name: "register/a-port-out-of-range", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","port":99999}` },
  // The numeric checks **accumulate**, so a port can be reported twice, and
  // which of them wrote the message decides where the message is serialized.
  { name: "register/a-port-that-is-a-float", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","port":3000.5}` },
  { name: "register/a-port-that-is-zero", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","port":0}` },
  { name: "register/a-port-that-is-negative", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","port":-1}` },
  { name: "register/a-port-that-is-a-negative-float", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","port":-1.5}` },
  { name: "register/an-env-value-that-is-a-number", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","env":{"PORT":3000}}` },
  { name: "register/an-env-value-that-is-null", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","env":{"PORT":null}}` },
  { name: "register/two-env-values-that-are-not-strings", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","env":{"A":1,"B":true}}` },
  // The key rule names `env` rather than the key, because it refines the map.
  { name: "register/an-env-key-that-is-not-a-name", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","env":{"a-b":"1"}}` },
  // Both wrong at once: the values are read first, and a bad one stops the key
  // refinement from running, so only the value is reported.
  { name: "register/an-env-with-a-bad-key-and-a-bad-value", path: REGISTER, body: `{"name":"demo","cwd":"${REPOS}/demo-app","command":"node -v","env":{"a-b":1}}` },
  // A blank name is a *dirty* failure, so the local arm is reported on its own
  // — but a blank name beside a missing command aborts that arm too, and the
  // report becomes the three-armed union.
  { name: "register/a-blank-name-and-no-command", path: REGISTER, body: `{"name":"","cwd":"${REPOS}/demo-app","kind":"docker-compose","composeService":"web","port":0}` },

  // --- register: registrations that work -------------------------------------
  { name: "register/a-local-service", path: REGISTER, body: `{"name":"api","cwd":"${REPOS}/demo-app","command":"node -v","port":4599,"description":"  a spaced description  "}` },
  // A string port is dropped rather than refused, so this registers without one.
  { name: "register/a-port-that-is-a-string", path: REGISTER, body: `{"name":"string-port","cwd":"${REPOS}/demo-app","command":"node -v","port":"4600"}` },
  { name: "register/a-blank-description", path: REGISTER, body: `{"name":"blank-description","cwd":"${REPOS}/demo-app","command":"node -v","description":"   "}` },
  { name: "register/an-env-that-is-an-array", path: REGISTER, body: `{"name":"array-env","cwd":"${REPOS}/demo-app","command":"node -v","env":["PORT=1"]}` },
  { name: "register/an-env-object", path: REGISTER, body: `{"name":"with-env","cwd":"${REPOS}/demo-app","command":"node -v","env":{"PORT":"3000"}}` },
  { name: "register/a-compose-service", path: REGISTER, body: `{"name":"web","kind":"docker-compose","cwd":"${REPOS}/demo-app","composeService":"web","composeFile":"docker-compose.yml","port":8081}` },
  // Registered as a local service, and the `host` it carried is dropped.
  { name: "register/an-ssh-kind-with-a-command", path: REGISTER, body: `{"name":"remote","kind":"ssh","cwd":"${REPOS}/demo-app","host":"box","command":"node -v"}` },
  { name: "register/a-name-that-is-already-registered", path: REGISTER, body: `{"name":"api","cwd":"${REPOS}/demo-app","command":"node -e 0"}` },
  // The clone is a git repository, so the best-effort Git-tab registration
  // succeeds here — and cannot be seen in the answer.
  { name: "register/the-config-so-far", config: true },

  // --- register: the database that rides along -------------------------------
  { name: "register/with-a-database", path: REGISTER, body: `{"name":"with-db","cwd":"${REPOS}/demo-app","command":"node -v","database":{"name":"appdb","engine":"postgres","url":"  postgres://localhost/app  "}}` },
  { name: "register/a-database-with-an-unknown-engine", path: REGISTER, body: `{"name":"bad-engine","cwd":"${REPOS}/demo-app","command":"node -v","database":{"name":"nope","engine":"oracle","url":"oracle://x"}}` },
  { name: "register/a-database-with-no-url", path: REGISTER, body: `{"name":"no-url","cwd":"${REPOS}/demo-app","command":"node -v","database":{"name":"nope","engine":"postgres"}}` },
  { name: "register/a-database-that-is-a-string", path: REGISTER, body: `{"name":"string-db","cwd":"${REPOS}/demo-app","command":"node -v","database":"appdb"}` },
  { name: "register/a-database-that-is-an-array", path: REGISTER, body: `{"name":"array-db","cwd":"${REPOS}/demo-app","command":"node -v","database":[{"name":"appdb","engine":"postgres","url":"postgres://x"}]}` },
  { name: "register/the-config-after-the-databases", config: true },

  // --- register: starting what was registered --------------------------------
  // `start` is compared to `true` itself, so a truthy string does not start it.
  { name: "register/start-is-a-string", path: REGISTER, body: `{"name":"not-started","cwd":"${REPOS}/demo-app","command":"sleep 30","start":"yes"}` },
  { name: "register/start-is-true", path: REGISTER, body: `{"name":"started","cwd":"${REPOS}/demo-app","command":"sleep 30","start":true}`, redact: ["pid", "startedAt"] },
  { name: "register/the-status-afterwards", method: "GET", path: "/api/status", redact: ["pid", "startedAt"] },
  // A second start of a service already holding its port. The refusal is not
  // caught separately here, so it is a 422 with the message and no `conflict`.
  { name: "register/a-start-that-conflicts", path: REGISTER, body: `{"name":"conflicting","cwd":"${REPOS}/demo-app","command":"sleep 30","port":4599,"start":true}`, redact: ["pid", "startedAt"] },
  { name: "register/wrong-method", method: "GET", path: REGISTER, body: "" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

let source = "";

function resolveTemplate(text: string, runtime: Runtime): string {
  return text.split("{{HOME}}").join(runtime.home).split("{{SOURCE}}").join(source);
}

async function credentialFor(runtime: Runtime): Promise<Record<string, string>> {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  if (step.config) {
    const raw = await readFile(
      join(runtime.home, ".config", "nomoreide", "config.json"),
      "utf8",
    ).catch(() => "");
    return { status: 0, contentType: null, body: raw ? JSON.parse(raw) : raw };
  }
  const headers: Record<string, string> = {
    ...(await credentialFor(runtime)),
    "content-type": "application/json",
  };
  const method = step.method ?? "POST";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : resolveTemplate(step.body ?? "", runtime),
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
  return value
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
}

function scrub(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        keys.includes(key) ? [key, "<redacted>"] : [key, scrub(item, keys)],
      ),
    );
  }
  return value;
}

function normalize(answer: Answer, runtime: Runtime, redact: readonly string[] = []): Answer {
  const body = JSON.parse(erase(JSON.stringify(answer.body), runtime));
  return { ...answer, body: redact.length ? scrub(body, redact) : body };
}

/** A committed git repository the runtimes can clone over `file://`. */
async function seedRepository(path: string, files: Record<string, string>): Promise<void> {
  await mkdir(path, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(path, name, ".."), { recursive: true });
    await writeFile(join(path, name), contents);
  }
  const git = (args: string[]) =>
    run("git", args, {
      cwd: path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Gate",
        GIT_AUTHOR_EMAIL: "gate@example.com",
        GIT_COMMITTER_NAME: "Gate",
        GIT_COMMITTER_EMAIL: "gate@example.com",
      },
    });
  await git(["init", "--initial-branch=main", "--quiet"]);
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "fixture"]);
}

/**
 * A repository carrying one of everything the scan looks for: two lockfiles
 * (so the fixed precedence decides), a manifest with a non-string script (so
 * the scripts map is quoted back rather than filtered), two Python dependency
 * hints in an order that decides the framework, a compose file whose services
 * spell `environment` both ways, an example env file with a comment and a blank
 * line, and a README long enough to be truncated.
 */
const DEMO_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "demo-app",
      scripts: { dev: "node server.js", build: "echo build", start: "node server.js", lint: 7 },
      dependencies: { express: "^4.0.0" },
    },
    null,
    2,
  ),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "yarn.lock": "# yarn\n",
  // `flask` is checked before `django`, so naming both settles on flask —
  // unless `manage.py` is there, which this repository does not have.
  "requirements.txt": "Flask==3.0.0\ndjango==5.0\n",
  "docker-compose.yml": [
    "services:",
    "  web:",
    "    build: .",
    "    ports:",
    '      - "8080:8080"',
    "    environment:",
    "      NODE_ENV: production",
    "      PORT: 8080",
    "  db:",
    "    image: postgres:16",
    "    ports:",
    "      - 5432:5432",
    "    environment:",
    "      - POSTGRES_PASSWORD=secret",
    "      - POSTGRES_DB=app",
    "  cache:",
    "    image: redis:7",
    "",
  ].join("\n"),
  Dockerfile: "FROM node:20\n",
  ".env.example": "# a comment\nDATABASE_URL=postgres://localhost/app\n\nAPI_KEY=shh\nNOT_A_PAIR\n",
  "README.md": `# Demo App\n\n${"Body text that runs on and on. ".repeat(60)}\n`,
  "src/index.js": "console.log('hi');\n",
};

const root = await mkdtemp(join(tmpdir(), "nmi-onboard-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  source = join(root, "source");
  await seedRepository(join(source, "demo-app"), DEMO_FILES);
  await seedRepository(join(source, "plain-repo"), { "notes.txt": "nothing to see\n" });
  // A directory that is not a repository, for the clone that fails.
  await mkdir(join(source, "not-a-repo"), { recursive: true });
  await writeFile(join(source, "not-a-repo", "file.txt"), "x\n");

  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
      () => [],
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
        normalize(answers.candidate, candidate, step.redact),
        normalize(answers.reference, reference, step.redact),
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
  console.log(`\nonboard parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\nonboard parity: ${steps.length} cases match`);
