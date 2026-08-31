/**
 * Phase 6 parity gate for the two project-summary endpoints:
 *
 *   GET /api/dashboard
 *   GET /api/overview/:domain
 *
 * The dashboard payload is the widest aggregation in the daemon — config,
 * service status, health, ports, recent logs, the selected repository's git
 * state, and the timeline, in one answer — so almost everything it reports is
 * built by a module that is already ported. What is *not* ported is the
 * assembly, and assembly is exactly where a field goes missing or arrives
 * under a different name without any single module being wrong.
 *
 * **Nothing is started.** Every service in the fixture is stopped, because a
 * running one would put a pid, an uptime and a port binding into the answer
 * that cannot match between two runtimes. The states that matter here are the
 * ones a page shows before anyone presses anything.
 *
 * Each runtime seeds its own repository, so commit hashes and author
 * timestamps differ by construction; those are erased, and everything else —
 * branch names, file states, counts, ordering — is compared.
 *
 * Usage:
 *   node --import tsx scripts/check-dashboard-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    "Usage: node --import tsx scripts/check-dashboard-parity.ts [--dump] <candidate> [args...]",
  );
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Gate",
        GIT_AUTHOR_EMAIL: "gate@example.com",
        GIT_COMMITTER_NAME: "Gate",
        GIT_COMMITTER_EMAIL: "gate@example.com",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}

/**
 * A repository with a committed history, a branch that is not the default, and
 * a working tree that is dirty in three different ways — staged, unstaged, and
 * untracked — so the status the dashboard reports has something to say.
 */
async function seedRepository(cwd: string): Promise<void> {
  const git = (...args: string[]) => run("git", args, cwd);
  const write = (path: string, contents: string) => writeFile(join(cwd, path), contents);

  await mkdir(join(cwd, "src"), { recursive: true });
  await git("init", "--quiet", "--initial-branch", "main");
  await git("config", "user.email", "gate@example.com");
  await git("config", "user.name", "Gate");

  await write("README.md", "# fixture\n");
  await write("src/main.ts", "export const one = 1;\n");
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "first");

  await write("src/main.ts", "export const one = 2;\n");
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "second");
  await git("branch", "feature/one");

  await write("src/main.ts", "export const one = 3;\n"); // unstaged
  await write("staged.txt", "staged\n");
  await git("add", "staged.txt");
  await write("untracked.txt", "untracked\n"); // untracked
}

const TIMELINE = [
  { at: "2026-08-01T10:00:00.000Z", kind: "service.start", service: "api", message: "api started" },
  { at: "2026-08-01T10:00:05.000Z", kind: "service.stop", service: "api", message: "api stopped" },
  { at: "2026-08-01T10:01:00.000Z", kind: "error", service: "web", message: "web failed once" },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

interface Step {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

const steps: Step[] = [
  { name: "dashboard/whole", method: "GET", path: "/api/dashboard" },
  { name: "overview/git", method: "GET", path: "/api/overview/git" },
  { name: "overview/github", method: "GET", path: "/api/overview/github" },
  { name: "overview/vercel", method: "GET", path: "/api/overview/vercel" },

  // --- refusals ---------------------------------------------------------------
  { name: "overview/an-unknown-domain", method: "GET", path: "/api/overview/nope" },
  { name: "overview/an-empty-domain", method: "GET", path: "/api/overview/" },
  { name: "overview/a-domain-that-needs-decoding", method: "GET", path: "/api/overview/git%20" },
  { name: "overview/rejects-post", method: "POST", path: "/api/overview/git" },
  { name: "overview/a-deeper-path", method: "GET", path: "/api/overview/git/extra" },
  { name: "dashboard/rejects-post", method: "POST", path: "/api/dashboard" },
  { name: "dashboard/a-trailing-slash", method: "GET", path: "/api/dashboard/" },
];

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

const credentials = new Map<Runtime, string>();

async function send(runtime: Runtime, step: Step): Promise<Answer> {
  const credential = credentials.get(runtime) ?? "";
  const response = await fetch(`http://127.0.0.1:${runtime.port}${step.path}`, {
    method: step.method,
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
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

/**
 * Erase only what cannot match: each runtime's own paths and port, and the
 * commit hashes git derives from a timestamp. Everything else survives, so a
 * missing field or a renamed one still fails.
 */
function normalize(value: unknown, runtime: Runtime): unknown {
  const text = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>")
    .split(String(runtime.port))
    .join("<port>")
    // The instant a health probe ran, which is "now" and nothing else. Erased
    // by name rather than by shape, so the timeline's own instants -- which
    // this gate wrote and must compare -- survive.
    .replace(/"checkedAt":"[^"]*"/g, '"checkedAt":"<now>"')
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/\b[0-9a-f]{7,12}\b/g, "<short-sha>");
  return JSON.parse(text);
}

const root = await mkdtemp(join(tmpdir(), "nmi-dashboard-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      ({ workspace }) => ({
        version: 1,
        services: [
          {
            name: "api",
            command: "node -e 'setInterval(()=>{},1000)'",
            cwd: workspace,
            port: 45231,
            env: { NODE_ENV: "test" },
          },
          { name: "web", command: "node -e 'setInterval(()=>{},1000)'", cwd: workspace, port: 45232 },
          { name: "worker", command: "node -e 'setInterval(()=>{},1000)'", cwd: workspace },
        ],
        bundles: [{ name: "all", services: ["api", "web"] }],
        databases: [],
        // A *subdirectory*, so the daemon's own working directory and the
        // repository it reports are two different paths. When they are the
        // same, `cwd` and `git.cwd` are interchangeable and a port that
        // reported the wrong one would pass.
        gitRepositories: [{ name: "fixture", path: join(workspace, "repo"), selected: true }],
      }),
      () => [],
    );
    await mkdir(join(runtime.workspace, "repo"), { recursive: true });
    await seedRepository(join(runtime.workspace, "repo"));
    await mkdir(join(runtime.home, ".nomoreide", "logs"), { recursive: true });
    await writeFile(join(runtime.home, ".nomoreide", "timeline.log"), `${TIMELINE}\n`);
    await writeFile(
      join(runtime.home, ".nomoreide", "logs", "api.log"),
      "api line one\napi line two\n",
    );
    await writeFile(join(runtime.home, ".nomoreide", "logs", "web.log"), "web line one\n");
    await harness.startDaemon(runtime, {}, runtime.workspace);
    credentials.set(
      runtime,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
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
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.log(`\ndashboard parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ndashboard parity: ${steps.length} cases match`);
