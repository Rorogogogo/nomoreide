/**
 * Runs every parity gate in `scripts/` against one candidate binary.
 *
 * The gates are the evidence for the Rust port: each launches the TypeScript
 * reference beside the native candidate and diffs what the two answer. They
 * are only evidence if they actually run, and `ci.yml` names them one
 * hardcoded step at a time — which is how the roster there came to cover 13 of
 * 65 while the rest ran nowhere but a laptop.
 *
 * So this **discovers** gates rather than listing them: every
 * `scripts/check-*-parity.ts` is a gate, and a new one is covered the moment
 * its file exists. Three of them take arguments that differ from the rest, and
 * those three names are the only ones written down here.
 *
 * Gates run one at a time by default. Each starts a reference daemon and a
 * candidate daemon, and a machine running several at once reports timeouts
 * that are contention rather than divergence. For the same reason a gate that
 * overruns is killed by *process group*, so a reference daemon cannot outlive
 * the gate that started it.
 *
 * Usage:
 *   node --import tsx scripts/run-parity-gates.ts <candidate> [options]
 *
 *     --only <substring>   run just the gates whose name contains this
 *     --jobs <n>           run n gates at once (default 1)
 *     --timeout <seconds>  per-gate limit (default 600)
 *     --allow-skips        a gate whose probe binary is missing is not a failure
 *     --list               print what would run, and run nothing
 */
import { spawn } from "node:child_process";
import { readdir, access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const scriptsDirectory = join(repositoryRoot, "scripts");

interface Gate {
  /** File name, which is also how the gate is named in output. */
  file: string;
  /** Arguments after the script path. */
  args: string[];
  /** A `cargo build --example` artifact this gate drives instead of the daemon. */
  example?: string;
}

/**
 * The gates whose arguments are not simply the candidate binary.
 *
 * Everything else takes `<candidate>` and appends its own subcommand, so the
 * default covers 62 of the 65 and keeps a new gate working with no edit here.
 */
const IRREGULAR: Record<string, (candidate: string) => Gate["args"]> = {
  // Not an MCP or HTTP surface: these drive their crate's own probe example,
  // and find it themselves when given no argument.
  "check-git-actions-parity.ts": () => [],
  "check-host-parity.ts": () => [],
  // The tool-surface gate wants a mode flag and an explicit subcommand.
  "check-mcp-parity.ts": (candidate) => ["--surface-only", candidate, "mcp"],
};

/** The probe binary each example-driven gate needs on disk. */
const EXAMPLES: Record<string, string> = {
  "check-git-actions-parity.ts": "git-actions-probe",
  "check-host-parity.ts": "vultr-probe",
};

async function discover(candidate: string): Promise<Gate[]> {
  const entries = await readdir(scriptsDirectory);
  return entries
    .filter((name) => /^check-.+-parity\.ts$/.test(name))
    .sort()
    .map((file) => ({
      file,
      args: (IRREGULAR[file] ?? ((c: string) => [c]))(candidate),
      example: EXAMPLES[file],
    }));
}

/**
 * Names any gate `package.json` knows about that the glob above would miss.
 *
 * Discovery keys off the `check-*-parity.ts` convention, so a gate committed
 * under some other name would be skipped in exactly the silent way this whole
 * script exists to prevent. Every gate has an npm script, so the two lists
 * disagreeing is the cheapest available warning that one got away.
 */
async function unreachable(found: Gate[]): Promise<string[]> {
  const { scripts } = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const known = new Set(found.map((gate) => gate.file));
  const referenced = new Set<string>();
  for (const [name, command] of Object.entries(scripts)) {
    if (name === "parity") continue;
    const match = /scripts\/(check-[\w-]+\.ts)/.exec(command);
    if (match?.[1] && !known.has(match[1])) referenced.add(match[1]);
  }
  return [...referenced].sort();
}

type Verdict = "passed" | "failed" | "timed out" | "skipped";

interface Result {
  gate: Gate;
  verdict: Verdict;
  seconds: number;
  /** One line for the running table. */
  detail: string;
  /** Everything the gate printed, kept so a failure can be acted on. */
  output: string;
}

/**
 * The line worth putting on a failing gate's name.
 *
 * The last line of a crashed gate is usually Node's version footer, and the
 * lines above it are stack frames — so a naive "last line" reads as
 * `Node.js v23.11.0` on the check that a reviewer sees first. The first line
 * that looks like a complaint is what actually says what went wrong; the whole
 * tail is printed separately for anyone who needs the rest.
 */
function complaint(lines: string[], fallback: string): string {
  // Node's crash preamble reads like a complaint without being one: `throw er;`
  // and `Unhandled 'error' event` both contain the word, and neither says what
  // broke. Frames, carets and the version footer go the same way.
  const noise =
    /^\s+at |^Node\.js v|node:internal|^\s*\^+\s*$|^\s*throw |Unhandled '.*' event/;
  const meaningful = lines.filter((line) => line.trim() && !noise.test(line));
  // An exception names itself at column zero; a gate that found a divergence
  // says so in its own words. Prefer either over whatever printed last.
  const thrown = meaningful.find((line) => /^\s*\w*(?:Error|Exception)\b/.test(line));
  const divergence = meaningful.find((line) =>
    /mismatch|diverge|does not match|differs|FAILED?\b/i.test(line),
  );
  return (thrown ?? divergence ?? meaningful.at(-1) ?? fallback).trim();
}

/**
 * Runs one gate to completion.
 *
 * The child gets its own process group so that a timeout can take down the
 * daemons it started along with it — killing only the gate leaves those
 * running, and they are long-lived enough to still be there days later.
 */
function run(gate: Gate, timeoutMs: number): Promise<Result> {
  return new Promise((settle) => {
    const started = Date.now();
    const child = spawn("node", ["--import", "tsx", join("scripts", gate.file), ...gate.args], {
      cwd: repositoryRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const seconds = (Date.now() - started) / 1000;
      const trimmed = output.trimEnd().split("\n");
      settle({
        gate,
        verdict: timedOut ? "timed out" : code === 0 ? "passed" : "failed",
        seconds,
        detail: timedOut
          ? `no result within ${timeoutMs / 1000}s`
          : code === 0
            ? (trimmed.at(-1) ?? "").trim() || "passed"
            : complaint(trimmed, `exit ${code}`),
        output,
      });
    });
  });
}

/** Reports rather than fails when a gate's probe binary was never built. */
async function missingExample(gate: Gate): Promise<Result | null> {
  if (!gate.example) return null;
  const path = join(repositoryRoot, "target/debug/examples", gate.example);
  try {
    await access(path);
    return null;
  } catch {
    return {
      gate,
      verdict: "skipped",
      seconds: 0,
      detail: `needs \`cargo build --example ${gate.example} -p nomoreide-actions\``,
      output: "",
    };
  }
}

function value(flag: string, fallback: string): string {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const positional = process.argv.slice(2).filter((a, index, all) => {
  if (a.startsWith("--")) return false;
  const previous = all[index - 1];
  return !(previous === "--only" || previous === "--jobs" || previous === "--timeout");
});
const candidate = positional[0];
if (!candidate && !flags.has("--list")) {
  console.error("Usage: node --import tsx scripts/run-parity-gates.ts <candidate> [--only x] [--jobs n] [--timeout s] [--list]");
  process.exit(2);
}

const only = value("--only", "");
const jobs = Math.max(1, Number(value("--jobs", "1")));
const timeoutMs = Number(value("--timeout", "600")) * 1000;

const all = await discover(candidate ? resolve(candidate) : "<candidate>");
const gates = only ? all.filter((g) => g.file.includes(only)) : all;

if (flags.has("--list")) {
  for (const gate of gates) console.log(gate.file, gate.args.join(" "));
  console.log(`\n${gates.length} gate(s)`);
  process.exit(0);
}
if (gates.length === 0) {
  console.error(`No parity gate matches --only ${only}`);
  process.exit(2);
}

const missed = await unreachable(all);
console.log(`Running ${gates.length} parity gate(s) against ${resolve(candidate)}, ${jobs} at a time.\n`);

const results: Result[] = [];
const queue = [...gates];
async function worker(): Promise<void> {
  for (let gate = queue.shift(); gate; gate = queue.shift()) {
    const skip = await missingExample(gate);
    const result = skip ?? (await run(gate, timeoutMs));
    results.push(result);
    const mark =
      result.verdict === "passed" ? "ok  " : result.verdict === "skipped" ? "skip" : "FAIL";
    console.log(
      `${mark} ${result.gate.file.padEnd(42)} ${result.seconds.toFixed(0).padStart(4)}s  ${result.detail.slice(0, 90)}`,
    );
  }
}
await Promise.all(Array.from({ length: jobs }, worker));

const failed = results.filter((r) => r.verdict === "failed" || r.verdict === "timed out");
const skipped = results.filter((r) => r.verdict === "skipped");
console.log(
  `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`,
);
for (const result of failed) {
  console.log(`\n--- ${result.gate.file} (${result.verdict}) ---`);
  console.log(
    result.output.trimEnd().split("\n").slice(-30).join("\n") || "(the gate printed nothing)",
  );
}
for (const result of skipped) console.log(`  SKIPPED ${result.gate.file}  ${result.detail}`);
for (const file of missed) console.log(`  UNREACHABLE ${file}  has an npm script but does not match check-*-parity.ts`);

// A gate that did not run is not evidence, so a skip fails by default and CI
// says nothing about it — the probe examples are built there, so a skip means
// something upstream broke. `--allow-skips` is for a working copy where the
// Rust side cannot currently be built.
const tolerated = flags.has("--allow-skips");

// Every gate now reports inside one CI step, so without this a failure is a
// line to scroll for. An annotation puts the gate's name on the check itself,
// and only for what is actually failing the build.
if (process.env.GITHUB_ACTIONS) {
  for (const result of tolerated ? failed : [...failed, ...skipped]) {
    console.log(`::error file=scripts/${result.gate.file}::${result.gate.file} ${result.verdict}: ${result.detail}`);
  }
  for (const file of missed) {
    console.log(`::error file=package.json::${file} has an npm script but does not match check-*-parity.ts, so it never runs`);
  }
}
process.exit(failed.length === 0 && missed.length === 0 && (tolerated || skipped.length === 0) ? 0 : 1);
