/**
 * Phase 3 git parity gate.
 *
 * Runs the TypeScript reference and a candidate binary against identical,
 * throwaway fixture repositories and compares what each reports through MCP.
 * Nothing here reads either implementation: the plan in
 * `test/fixtures/mcp-git-parity-v1.json` drives both runtimes with the same
 * ordered calls and the payloads are diffed.
 *
 * Unlike the Phase 2 runtime gate, no daemon is involved — the git config tools
 * write `config.json` directly in both runtimes, so each one only needs a home
 * of its own.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-git-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { callMcpTool, type McpCommand } from "../test/support/mcp-contract.js";

const execFileAsync = promisify(execFile);

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const candidateArgv = argv.filter((argument) => argument !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-git-parity.ts [--dump] <candidate-command> [candidate-args...]",
  );
}

const root = resolve(import.meta.dirname, "..");

interface Fixture {
  fixtureVersion: 1;
  repositories: Array<{
    id: string;
    initialBranch: string;
    commits: Array<{ file: string; contents: string; message: string }>;
  }>;
  plainDirectories: string[];
  plan: Array<{
    id: string;
    tool: string;
    arguments: Record<string, unknown>;
  }>;
}

const fixture = JSON.parse(
  await readFile(join(root, "test/fixtures/mcp-git-parity-v1.json"), "utf8"),
) as Fixture;
if (fixture.fixtureVersion !== 1) {
  throw new Error(`Unsupported git parity fixture version ${fixture.fixtureVersion}`);
}

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

interface Runtime {
  label: string;
  command: string;
  args: string[];
  home: string;
  /** Fixture id -> absolute path in this runtime's own tree. */
  paths: Map<string, string>;
}

const specs = [
  { label: "reference", command: process.execPath, args: ["--import", "tsx", "src/index.ts"] },
  { label: "candidate", command: candidateArgv[0], args: candidateArgv.slice(1) },
];

const roots: string[] = [];
try {
  const runtimes: Runtime[] = [];
  for (const spec of specs) {
    runtimes.push(await prepare(spec));
  }

  let compared = 0;
  for (const step of fixture.plan) {
    const payloads = await Promise.all(runtimes.map((runtime) => call(runtime, step)));
    if (dump) {
      for (const [index, payload] of payloads.entries()) {
        console.log(`\n--- ${step.id} [${runtimes[index].label}]`);
        console.log(JSON.stringify(payload, null, 2));
      }
    }
    try {
      assert.deepStrictEqual(payloads[1], payloads[0]);
    } catch (error) {
      console.error(`\nGit parity failed at step "${step.id}" (${step.tool}).`);
      console.error(`reference: ${JSON.stringify(payloads[0], null, 2)}`);
      console.error(`candidate: ${JSON.stringify(payloads[1], null, 2)}`);
      throw error;
    }
    compared += 1;
  }

  console.log(`MCP git parity passed (${compared} steps).`);
} finally {
  await Promise.all(
    roots.map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}),
    ),
  );
}

async function prepare(spec: { label: string; command: string; args: string[] }): Promise<Runtime> {
  const base = await mkdtemp(join(tmpdir(), `nomoreide-git-parity-${spec.label}-`));
  roots.push(base);
  const home = join(base, "home");
  await mkdir(join(home, ".config", "nomoreide"), { recursive: true });

  const paths = new Map<string, string>();
  for (const repository of fixture.repositories) {
    const path = join(base, "repos", repository.id);
    await mkdir(path, { recursive: true });
    // --initial-branch keeps the fixture independent of the machine's
    // init.defaultBranch, which otherwise differs between developers and CI.
    await git(path, ["init", "--quiet", `--initial-branch=${repository.initialBranch}`]);
    await git(path, ["config", "user.email", "parity@nomoreide.test"]);
    await git(path, ["config", "user.name", "NoMoreIDE Parity"]);
    await git(path, ["config", "commit.gpgsign", "false"]);
    for (const commit of repository.commits) {
      await writeFile(join(path, commit.file), commit.contents);
      await git(path, ["add", commit.file]);
      await git(path, ["commit", "--quiet", "-m", commit.message]);
    }
    paths.set(`repo:${repository.id}`, path);
  }
  for (const directory of fixture.plainDirectories) {
    const path = join(base, "plain", directory);
    await mkdir(path, { recursive: true });
    paths.set(`dir:${directory}`, path);
  }
  paths.set("home", home);

  return { ...spec, home, paths };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function command(runtime: Runtime): McpCommand {
  return {
    command: runtime.command,
    args: [...runtime.args, "mcp"],
    cwd: root,
    env: {
      ...inheritedEnv,
      HOME: runtime.home,
      XDG_CONFIG_HOME: join(runtime.home, ".config"),
      NOMOREIDE_AUTO_UI: "0",
    },
  };
}

/** `{{repo:demo}}`, `{{dir:not-a-repo}}`, and `{{home}}` become this runtime's own paths. */
function substitute(value: unknown, runtime: Runtime): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(/\{\{([^}]+)\}\}/g, (whole, key: string) => {
    const path = runtime.paths.get(key);
    if (path === undefined) {
      throw new Error(`Unknown fixture placeholder ${whole}`);
    }
    return path;
  });
}

async function call(runtime: Runtime, step: Fixture["plan"][number]): Promise<unknown> {
  const args = Object.fromEntries(
    Object.entries(step.arguments).map(([key, value]) => [key, substitute(value, runtime)]),
  );
  const response = await callMcpTool(command(runtime), step.tool, args);
  return normalize(response, runtime);
}

/**
 * Replace what cannot repeat between two equivalent runs — each runtime's own
 * throwaway paths — and parse the tool's JSON payload so that key *order*,
 * which `serde_json` sorts and the reference does not, is not compared. Message
 * text, error codes, and every field are compared verbatim.
 */
function normalize(response: unknown, runtime: Runtime): unknown {
  const tokens: Array<[string, string]> = [...runtime.paths]
    .map(([key, path]) => [path, `<${key}>`] as [string, string])
    // Longest first, so a nested path is not partly rewritten by its parent.
    .sort((left, right) => right[0].length - left[0].length);

  const rewrite = (text: string): string =>
    tokens.reduce((current, [path, token]) => current.split(path).join(token), text);

  const result = (response as { result?: { content?: Array<{ text?: string }> } }).result;
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    const rewritten = rewrite(text);
    let payload: unknown = rewritten;
    try {
      payload = JSON.parse(rewritten);
    } catch {
      // A refusal is plain prose, not JSON; compare the sentence itself.
    }
    return {
      isError: (result as { isError?: boolean }).isError ?? false,
      payload,
    };
  }
  return JSON.parse(rewrite(JSON.stringify(response)));
}
