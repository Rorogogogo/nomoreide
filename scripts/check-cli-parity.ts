/**
 * Phase 8 parity gate for the `nomoreide` command line itself.
 *
 * Every other gate in this directory compares two daemons over HTTP. This one
 * compares two **processes**: it runs the same argument vector through the
 * TypeScript reference and the native binary and diffs three things a script
 * can observe — stdout, stderr, and the exit code.
 *
 * The exit code is the reason this gate exists. `runCli` answers `1` for a
 * caller's mistake and `2` for a runtime failure, and nothing else in the
 * suite looks at it: a command that prints the right words and exits `0` on
 * failure passes every HTTP gate while breaking every `set -e` script that
 * wraps it. The stream matters for the same reason — a refusal printed to
 * stdout is a refusal that lands in a pipeline's data.
 *
 * ## What is deliberately not compared
 *
 * * **`setup`.** The native build's instructions name `nomoreide mcp`; the
 *   reference's name `npx -y nomoreide`. That divergence is the point of the
 *   port and is asserted in `crates/nomoreide-cli/src/setup.rs`, not here.
 * * **The deprecation banner.** The reference prints it only when stderr is a
 *   TTY, and every process here is spawned with pipes, so it never appears on
 *   either side. Nothing to compare, and nothing hidden.
 * * **Key order inside a JSON payload.** `start`/`stop`/`restart` print the
 *   daemon's answer through `JSON.stringify(..., null, 2)`, so the key order is
 *   whichever daemon produced it. Those steps are marked `json` and compared as
 *   parsed documents, matching how every HTTP gate in this suite treats the
 *   same payloads. Text steps are compared byte for byte.
 *
 * Usage:
 *   node --import tsx scripts/check-cli-parity.ts <candidate> [args...]
 *   ... --dump          print both transcripts per step
 *   ... --only <frag>   run only steps whose name contains <frag>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
  type WorkspaceFile,
} from "../test/support/runtime-parity.js";

const raw = process.argv.slice(2);
const dump = raw.includes("--dump");
const onlyIndex = raw.indexOf("--only");
const only = onlyIndex >= 0 ? raw[onlyIndex + 1] : undefined;
const argv = raw.filter(
  (value, index) =>
    value !== "--dump" && value !== "--only" && index !== (onlyIndex >= 0 ? onlyIndex + 1 : -1),
);
if (argv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-cli-parity.ts [--dump] [--only <frag>] <candidate> [args...]",
  );
}

interface Step {
  readonly name: string;
  /** Arguments after the executable — the whole command line the user types. */
  readonly args: string[];
  /**
   * Keystrokes to write to stdin, for the TUI — one array entry per key.
   *
   * The reference only asks for raw mode when stdin is a TTY, and a pipe is
   * not one, so both runtimes read a piped keystroke exactly as they would
   * read a typed one and every frame they draw lands in the captured stdout.
   * That is what makes an interactive screen comparable at all here.
   *
   * They are written **one at a time, spaced apart**, and that is not
   * incidental. The reference's keypress handler is `async` and Node does not
   * await it before firing the next event, so two keys arriving inside one
   * render round-trip both mutate the screen state before either frame is
   * drawn — `b` `b` toggles to bundles and back and draws the services screen
   * three times. Writing the whole sequence at once would make this gate
   * assert that race rather than the behaviour, and no human types fast enough
   * to reach it. An array entry is one key, so an escape sequence stays in one
   * write and is not mistaken for a bare escape.
   */
  readonly stdin?: string[];
  /** Compare stdout as a parsed JSON document rather than as text. */
  readonly json?: boolean;
  /** Seconds to allow. Only the daemon-backed steps need more than the default. */
  readonly timeoutMs?: number;
}

/** Arrow keys, as a terminal sends them: one escape sequence, one write. */
const UP = "\u001b[A";
const DOWN = "\u001b[B";

/**
 * The plan is a **walk**, not a set: `add` steps register what later `list`,
 * `start` and `logs` steps read back. Order is therefore load-bearing, and a
 * step inserted in the middle changes what everything after it sees.
 */
const PLAN: Step[] = [
  // --- dispatch and the usage contract ---------------------------------------
  { name: "usage/unknown-command", args: ["definitely-not-a-command"] },
  { name: "usage/unknown-command-with-a-subcommand", args: ["nope", "sub"] },
  { name: "usage/add-with-no-subcommand", args: ["add"] },
  { name: "usage/add-with-an-unknown-subcommand", args: ["add", "widget"] },

  // --- registering a service -------------------------------------------------
  { name: "add/service-with-no-name", args: ["add", "service"] },
  { name: "add/service-with-no-command", args: ["add", "service", "alpha"] },
  // No `--port`: a service with one makes the daemon wait for that port to
  // open before it reports a start, and this fixture never binds anything. The
  // port column is covered by `beta`, which is registered and never started.
  {
    name: "add/service-local",
    args: ["add", "service", "alpha", "--command", "sh serve.sh"],
  },
  {
    name: "add/service-with-inline-flag-values",
    args: ["add", "service", "beta", "--command=printf beta", "--port=4002"],
  },
  {
    name: "add/service-with-env-and-args",
    args: [
      "add",
      "service",
      "gamma",
      "--command",
      "printf gamma",
      "--args",
      '["one","two"]',
      "--env",
      '{"A":"1","B":"2"}',
      "--description",
      "a described service",
    ],
  },
  {
    name: "add/service-rejects-a-non-array-args-flag",
    args: ["add", "service", "delta", "--command", "true", "--args", '{"not":"an array"}'],
  },
  {
    name: "add/service-rejects-unparseable-args",
    args: ["add", "service", "delta", "--command", "true", "--args", "not json at all"],
  },
  {
    name: "add/service-rejects-a-non-string-env-value",
    args: ["add", "service", "delta", "--command", "true", "--env", '{"A":1}'],
  },
  {
    name: "add/service-rejects-an-env-array",
    args: ["add", "service", "delta", "--command", "true", "--env", '["A"]'],
  },

  // The parser quirks, exercised end to end rather than only in the Rust unit
  // tests: `--command=` is falsy, so it reads as a missing command *and* eats
  // the argument after it.
  {
    name: "add/service-with-an-empty-inline-command",
    args: ["add", "service", "epsilon", "--command=", "--port", "4009"],
  },
  // A second `=` is dropped by the reference's two-argument `split`, so this
  // registers the description "a" rather than "a=b".
  {
    name: "add/service-with-two-equals-signs",
    args: ["add", "service", "zeta", "--command", "true", "--description=a=b"],
  },
  { name: "add/service-list-after-the-quirks", args: ["list"] },

  // --- compose and ssh services ----------------------------------------------
  {
    name: "add/compose-without-a-compose-service",
    args: ["add", "service", "compose-a", "--kind", "docker-compose"],
  },
  {
    name: "add/compose-service",
    args: [
      "add",
      "service",
      "compose-a",
      "--kind",
      "docker-compose",
      "--compose-service",
      "web",
      "--compose-file",
      "docker-compose.yml",
    ],
  },
  { name: "add/ssh-without-a-host", args: ["add", "service", "ssh-a", "--kind", "ssh"] },
  {
    name: "add/ssh-without-a-command",
    args: ["add", "service", "ssh-a", "--kind", "ssh", "--host", "example.internal"],
  },
  {
    name: "add/ssh-without-a-cwd",
    args: [
      "add",
      "service",
      "ssh-a",
      "--kind",
      "ssh",
      "--host",
      "example.internal",
      "--command",
      "printf remote",
    ],
  },
  {
    name: "add/ssh-service",
    args: [
      "add",
      "service",
      "ssh-a",
      "--kind",
      "ssh",
      "--host",
      "example.internal",
      "--command",
      "printf remote",
      "--cwd",
      "/srv/app",
    ],
  },
  // A compose and an ssh service have no `command`, and the reference prints
  // the JavaScript interpolation of `undefined` into that column rather than
  // leaving it blank. This is the step that pins it.
  { name: "add/list-with-commandless-services", args: ["list"] },

  // --- bundles ---------------------------------------------------------------
  { name: "add/bundle-with-no-name", args: ["add", "bundle"] },
  { name: "add/bundle-with-no-services", args: ["add", "bundle", "empty"] },
  { name: "add/bundle", args: ["add", "bundle", "pair", "alpha", "beta"] },
  { name: "add/bundle-naming-an-unregistered-service", args: ["add", "bundle", "ghosts", "nobody"] },
  { name: "add/bundle-replaces-a-same-named-one", args: ["add", "bundle", "pair", "alpha"] },
  { name: "add/list-with-bundles", args: ["list"] },

  // --- the daemon-backed commands --------------------------------------------
  { name: "runtime/logs-with-no-name", args: ["logs"] },
  { name: "runtime/start-with-no-name", args: ["start", ""] },
  { name: "runtime/stop-with-no-name", args: ["stop"] },
  { name: "runtime/restart-with-no-name", args: ["restart"] },
  {
    name: "runtime/start-an-unregistered-service",
    args: ["start", "no-such-service"],
    timeoutMs: 30_000,
  },
  { name: "runtime/logs-for-an-unregistered-service", args: ["logs", "no-such-service"] },
  {
    name: "runtime/start-a-service",
    args: ["start", "alpha"],
    json: true,
    timeoutMs: 30_000,
  },
  // Placed here, while exactly one service is running and nothing has
  // fabricated a phantom yet, so the running-service line is compared for
  // real rather than pinned.
  { name: "daemon/status-with-one-service-running", args: ["daemon", "status"], timeoutMs: 30_000 },
  { name: "runtime/logs-after-a-start", args: ["logs", "alpha"] },
  { name: "runtime/stop-a-service", args: ["stop", "alpha"], json: true, timeoutMs: 30_000 },
  {
    name: "runtime/restart-a-stopped-service",
    args: ["restart", "alpha"],
    json: true,
    timeoutMs: 30_000,
  },
  { name: "runtime/stop-again", args: ["stop", "alpha"], json: true, timeoutMs: 30_000 },
  { name: "daemon/status-with-nothing-running", args: ["daemon", "status"], timeoutMs: 30_000 },

  // --- the declared divergence, and the mess it leaves behind ----------------
  // Everything from here on is contaminated on the reference side, which is
  // why it comes last: the two steps below each fabricate a service that never
  // existed, and every later status read has to account for them.
  {
    name: "runtime/stop-an-unregistered-service",
    args: ["stop", "no-such-service"],
    json: true,
    timeoutMs: 30_000,
  },
  // `restart` has no bundle branch in the reference: the bundle name is looked
  // up as a *service*, there is none, and the start half fails — but the stop
  // half has already run, leaving its own phantom behind.
  { name: "runtime/restart-a-bundle-name", args: ["restart", "pair"], timeoutMs: 30_000 },
  { name: "daemon/status-after-the-phantoms", args: ["daemon", "status"], timeoutMs: 30_000 },

  // --- git -------------------------------------------------------------------
  // Every step runs inside the runtime's own workspace, which the harness
  // seeds as a real repository, so these read a tree neither runtime shares
  // with this checkout.
  { name: "git/no-subcommand", args: ["git"] },
  { name: "git/unknown-subcommand", args: ["git", "wat"] },
  { name: "git/status", args: ["git", "status"] },
  { name: "git/branch", args: ["git", "branch"] },
  { name: "git/log", args: ["git", "log"] },
  { name: "git/log-with-a-limit", args: ["git", "log", "--limit", "1"] },
  { name: "git/log-with-a-nonsense-limit", args: ["git", "log", "--limit", "banana"] },
  { name: "git/diff-of-a-clean-tree", args: ["git", "diff"] },
  { name: "git/staged-diff-of-a-clean-tree", args: ["git", "staged-diff"] },
  { name: "git/commit-with-no-message", args: ["git", "commit"] },
  { name: "git/switch-with-no-branch", args: ["git", "switch"] },
  { name: "git/create-branch-with-no-name", args: ["git", "create-branch"] },
  { name: "git/create-branch", args: ["git", "create-branch", "side"] },
  { name: "git/status-on-the-new-branch", args: ["git", "status"] },
  { name: "git/switch-back", args: ["git", "switch", "main"] },
  { name: "git/switch-to-a-branch-that-is-not-there", args: ["git", "switch", "nope"] },
  { name: "git/stage-a-file", args: ["git", "stage", "tracked.txt"] },
  { name: "git/status-after-staging", args: ["git", "status"] },
  { name: "git/unstage-a-file", args: ["git", "unstage", "tracked.txt"] },
  { name: "git/add-repo-with-no-name", args: ["git", "add-repo"] },
  { name: "git/add-repo-with-no-path", args: ["git", "add-repo", "fixture"] },
  { name: "git/select-repo-that-is-not-registered", args: ["git", "select-repo", "ghost"] },

  // --- agents ----------------------------------------------------------------
  { name: "agents/status", args: ["agents", "status"] },
  { name: "agents/status-is-the-default", args: ["agents"] },
  { name: "agents/unknown-subcommand", args: ["agents", "wat"] },
  { name: "agents/read-all", args: ["agents", "read"], json: true },
  { name: "agents/read-one", args: ["agents", "read", "claude"], json: true },
  { name: "agents/read-an-unknown-agent", args: ["agents", "read", "emacs"] },

  // --- db --------------------------------------------------------------------
  { name: "db/no-subcommand", args: ["db"] },
  { name: "db/unknown-subcommand", args: ["db", "wat"] },
  { name: "db/list-when-empty", args: ["db", "list"], json: true },
  { name: "db/add-with-no-name", args: ["db", "add"] },
  { name: "db/add-with-no-engine", args: ["db", "add", "local"] },
  {
    name: "db/add-with-an-unsupported-engine",
    args: ["db", "add", "local", "--engine", "oracle", "--url", "x"],
  },
  { name: "db/add-with-no-url", args: ["db", "add", "local", "--engine", "sqlite"] },
  // `--no-check` so neither runtime has to open the file; the registration
  // itself is what this pins.
  {
    name: "db/add-a-sqlite-connection",
    args: ["db", "add", "local", "--engine", "sqlite", "--url", "fixture.db", "--no-check"],
    json: true,
  },
  { name: "db/list-after-adding", args: ["db", "list"], json: true },
  {
    name: "db/add-the-same-name-again",
    args: ["db", "add", "local", "--engine", "sqlite", "--url", "other.db", "--no-check"],
  },
  // `--replace` is a bare presence test on the raw arguments in the reference,
  // which is why it survives being written as `--replace` with a positional
  // after it — the `db` reader knows it takes no value.
  {
    name: "db/replace-an-existing-connection",
    args: [
      "db",
      "add",
      "local",
      "--engine",
      "sqlite",
      "--url",
      "other.db",
      "--no-check",
      "--replace",
    ],
    json: true,
  },
  { name: "db/check-an-unregistered-connection", args: ["db", "check", "ghost"] },
  { name: "db/schemas-of-an-unregistered-connection", args: ["db", "schemas", "ghost"] },
  { name: "db/objects-with-no-schema-flag", args: ["db", "objects", "local"] },
  { name: "db/describe-with-no-key", args: ["db", "describe", "local"] },
  { name: "db/sample-with-no-table", args: ["db", "sample", "local"] },
  { name: "db/sample-with-a-bad-limit", args: ["db", "sample", "local", "t", "--limit", "0"] },
  { name: "db/sample-with-a-bad-offset", args: ["db", "sample", "local", "t", "--offset", "-1"] },
  { name: "db/query-with-no-sql", args: ["db", "query", "local"] },
  { name: "db/remove-a-connection", args: ["db", "remove", "local"] },
  { name: "db/list-after-removing", args: ["db", "list"], json: true },

  // --- profile ---------------------------------------------------------------
  { name: "profile/list-when-empty", args: ["profile", "list"] },
  { name: "profile/list-is-the-default", args: ["profile"] },
  { name: "profile/unknown-subcommand", args: ["profile", "wat"] },
  { name: "profile/show-with-no-name", args: ["profile", "show"] },
  { name: "profile/show-a-profile-that-is-not-there", args: ["profile", "missing"] },
  { name: "profile/snapshot-with-no-agent", args: ["profile", "snapshot"] },
  { name: "profile/snapshot-with-an-unknown-agent", args: ["profile", "snapshot", "emacs", "p"] },
  { name: "profile/snapshot-with-no-name", args: ["profile", "snapshot", "claude"] },
  { name: "profile/snapshot", args: ["profile", "snapshot", "claude", "kit"] },
  { name: "profile/list-after-a-snapshot", args: ["profile", "list"] },
  { name: "profile/snapshot-the-same-name-again", args: ["profile", "snapshot", "claude", "kit"] },
  { name: "profile/apply-with-no-agent", args: ["profile", "apply", "kit"] },
  { name: "profile/apply-dry-run", args: ["profile", "apply", "kit", "claude", "--dry-run"] },
  { name: "profile/delete-with-no-name", args: ["profile", "delete"] },
  { name: "profile/delete", args: ["profile", "delete", "kit"] },
  { name: "profile/delete-again", args: ["profile", "delete", "kit"] },
  { name: "profile/import-with-no-archive", args: ["profile", "import"] },
  { name: "profile/import-an-archive-that-is-not-there", args: ["profile", "import", "nope.tgz"] },
  { name: "profile/export-a-profile-that-is-not-there", args: ["profile", "export", "kit"] },
  { name: "profile/publish-without-a-slug", args: ["profile", "publish", "kit"] },

  // --- tui -------------------------------------------------------------------
  // Each case ends in `q`, so the process exits on its own rather than being
  // killed on the timeout — a killed process would compare its signal instead
  // of its frames.
  { name: "tui/opening-frame", args: ["tui"], stdin: ["q"], timeoutMs: 60_000 },
  {
    name: "tui/moving-down-the-service-list",
    args: ["tui"],
    stdin: [DOWN, DOWN, "q"],
    timeoutMs: 60_000,
  },
  // Down past the end clamps to the last row rather than running off it.
  {
    name: "tui/moving-past-the-end",
    args: ["tui"],
    stdin: [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, "q"],
    timeoutMs: 90_000,
  },
  { name: "tui/moving-up-from-the-top", args: ["tui"], stdin: [UP, UP, "q"], timeoutMs: 60_000 },
  { name: "tui/the-bundles-screen", args: ["tui"], stdin: ["b", "q"], timeoutMs: 60_000 },
  { name: "tui/toggling-bundles-off-again", args: ["tui"], stdin: ["b", "b", "q"], timeoutMs: 60_000 },
  { name: "tui/selecting-a-bundle", args: ["tui"], stdin: ["b", DOWN, "q"], timeoutMs: 60_000 },
  { name: "tui/the-logs-screen", args: ["tui"], stdin: ["l", "q"], timeoutMs: 60_000 },
  {
    name: "tui/escape-returns-to-services",
    args: ["tui"],
    stdin: ["l", "\u001b", "q"],
    timeoutMs: 60_000,
  },
  // Ctrl-C leaves by the same door as `q`, and leaves the services running.
  { name: "tui/ctrl-c-quits", args: ["tui"], stdin: ["\u0003"], timeoutMs: 60_000 },
  {
    name: "tui/an-unnamed-escape-sequence-still-redraws",
    args: ["tui"],
    stdin: ["\u001b[C", "q"],
    timeoutMs: 60_000,
  },

  // --- daemon management -----------------------------------------------------
  { name: "daemon/unknown-subcommand", args: ["daemon", "wat"] },
  { name: "daemon/unknown-subcommand-after-a-port-flag", args: ["daemon", "--port=1", "wat"] },
];

/**
 * Divergences that are decided, not accidental.
 *
 * A pin is not a skip: it names **both** sides exactly, so it fails if either
 * runtime changes. Reproducing the reference here would mean reproducing a
 * bug, and hiding it would mean the gate stops describing what the binary
 * actually does.
 */
const PINNED: {
  readonly step: string;
  readonly why: string;
  readonly reference: unknown;
  readonly candidate: unknown;
}[] = [
  {
    step: "runtime/stop-an-unregistered-service",
    why:
      "Stopping is a remediation capability, so the native runtime keeps it reachable for a name this daemon is running even after its config was edited away — but it refuses a name nobody ever registered. The reference stops by name without consulting config at all: it answers `stopped` for a typo, and records a runtime entry and a timeline event for a service that has never existed. Already declared at `error/stop-unregistered` in check-mcp-runtime-parity.ts and enforced by RuntimeState::stop_service.",
    reference: {
      code: 0,
      signal: null,
      stdout: { name: "no-such-service", state: "stopped" },
      stderr: "",
    },
    candidate: {
      code: 2,
      signal: null,
      stdout: { unparsed: "" },
      stderr: 'Service "no-such-service" is not registered.\n',
    },
  },
  {
    step: "daemon/status-after-the-phantoms",
    why:
      "The count is the visible residue of the pin above. `restartService` stops before it starts, so a failed restart of an unregistered name leaves the same fabricated entry behind as a bare stop does — the reference is now reporting two services that were never registered (`no-such-service` and `pair`) on top of the one that was. The native runtime refused both, so it reports only `alpha`.",
    reference: {
      code: 0,
      signal: null,
      stdout:
        "NoMoreIDE daemon: running at http://127.0.0.1:<port> (pid <pid>, v<version>)\nServices: 0 running / 3 known\n",
      stderr: "",
    },
    candidate: {
      code: 0,
      signal: null,
      stdout:
        "NoMoreIDE daemon: running at http://127.0.0.1:<port> (pid <pid>, v<version>)\nServices: 0 running / 1 known\n",
      stderr: "",
    },
  },
];

interface Transcript {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How long to leave between two TUI keystrokes.
 *
 * Long enough for a render — a config read plus two daemon round-trips — to
 * finish before the next key lands, on the slowest runner. Shorter, and the
 * reference's un-awaited keypress handlers overlap and the gate starts
 * comparing a race.
 */
const KEY_INTERVAL_MS = 600;


function invoke(runtime: Runtime, step: Step, harness: RuntimeHarness): Promise<Transcript> {
  return new Promise((resolve, reject) => {
    // Always the runtime's own workspace, never this checkout: a bare `--cwd`
    // defaults to `process.cwd()`, and pointing both runtimes at the repo root
    // would let one gate run see the other's project state.
    const child = spawn(runtime.command, [...runtime.args, ...step.args], {
      cwd: runtime.workspace,
      env: harness.env(runtime),
      stdio: [step.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (step.stdin !== undefined) {
      void (async () => {
        for (const key of step.stdin ?? []) {
          await new Promise((tick) => setTimeout(tick, KEY_INTERVAL_MS));
          child.stdin?.write(key);
        }
        child.stdin?.end();
      })();
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${runtime.label} timed out running: ${step.args.join(" ")}`));
    }, step.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Erase what cannot match between two equivalent runs, and nothing else.
 *
 * Each rule below is here because the value is genuinely unrepeatable — a
 * path, a port, a pid, a clock reading — not because the two runtimes
 * disagree about it. Anything a rule would hide that is *not* one of those is
 * a hole in the gate, so the rules are written as narrowly as the text allows.
 */
function scrub(text: string, runtimes: readonly Runtime[]): string {
  let scrubbed = text;
  for (const runtime of runtimes) {
    scrubbed = scrubbed
      .split(runtime.workspace)
      .join("<workspace>")
      .split(runtime.home)
      .join("<home>")
      .split(String(runtime.port))
      .join("<port>");
  }
  return (
    scrubbed
      // A pid, wherever the CLI renders one.
      .replace(/\bpid \d+/g, "pid <pid>")
      .replace(/"pid":\s*\d+/g, '"pid": <pid>')
      // ISO-8601 to the millisecond, as `logs` and the status payloads print it.
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")
      // The two runtimes read their version from different files — package.json
      // and Cargo.toml. Keeping them in step is `deploy.yml`'s job, not this
      // gate's, and a drift there would otherwise fail every daemon step for a
      // reason that has nothing to do with the CLI.
      .replace(/\bv\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\b/g, "v<version>")
      // A port the harness assigned, wherever it survived the split above.
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
  );
}

/**
 * The same erasure, applied to a parsed document rather than to its text.
 *
 * Scrubbing the text first and parsing afterwards does not work: `"pid": 41`
 * becomes `"pid": <pid>`, which is no longer JSON, and the step silently
 * degrades into a text comparison that fails on key order. So a `json` step
 * parses the raw output and scrubs the tree.
 */
function scrubValue(value: unknown, runtimes: readonly Runtime[]): unknown {
  if (typeof value === "string") return scrub(value, runtimes);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, runtimes));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "pid" && typeof child === "number" ? "<pid>" : scrubValue(child, runtimes),
      ]),
    );
  }
  return value;
}

/** stdout for a `json` step, parsed; the raw text otherwise. */
function readStdout(step: Step, transcript: Transcript, runtimes: readonly Runtime[]): unknown {
  if (!step.json) return scrub(transcript.stdout, runtimes);
  try {
    return scrubValue(JSON.parse(transcript.stdout), runtimes);
  } catch {
    // A step that should print JSON and did not is itself the divergence, so
    // the unparsed text is handed on rather than swallowed.
    return { unparsed: scrub(transcript.stdout, runtimes) };
  }
}

function compare(step: Step, transcript: Transcript, runtimes: readonly Runtime[]): unknown {
  return {
    code: transcript.code,
    signal: transcript.signal,
    stdout: readStdout(step, transcript, runtimes),
    stderr: scrub(transcript.stderr, runtimes),
  };
}

/** Fixed so both runtimes' seed commits hash identically. */
const SEED_DATE = "2020-01-02T03:04:05+00:00";

/** A service each runtime can actually run, so `start` has something to start. */
function workspaceFiles(): WorkspaceFile[] {
  return [
    {
      path: "serve.sh",
      executable: true,
      contents: ["#!/bin/sh", 'printf "alpha listening\\n"', "while :; do sleep 1; done", ""].join(
        "\n",
      ),
    },
    { path: "tracked.txt", contents: "one\n" },
  ];
}

/**
 * Make a runtime's workspace a real repository with one commit on `main`.
 *
 * Identity, dates and branch name are all pinned rather than inherited. The
 * machine's `user.email`, `init.defaultBranch` and commit-signing config would
 * otherwise decide what `git status` and `git branch` print, and the gate would
 * pass or fail depending on whose laptop it ran on.
 *
 * The **dates** matter for a subtler reason: a commit hash is computed over its
 * timestamps, so two seeds a second apart produce two different hashes, and
 * `git log` — which prints the first eight characters of one — then diverges
 * for a reason that has nothing to do with either runtime. Pinning them makes
 * both repositories bit-identical.
 */
async function seedRepository(workspace: string): Promise<void> {
  const git = (...args: string[]) =>
    new Promise<void>((resolveGit, reject) => {
      const child = spawn("git", args, {
        cwd: workspace,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Parity",
          GIT_AUTHOR_EMAIL: "parity@example.invalid",
          GIT_COMMITTER_NAME: "Parity",
          GIT_COMMITTER_EMAIL: "parity@example.invalid",
          GIT_AUTHOR_DATE: SEED_DATE,
          GIT_COMMITTER_DATE: SEED_DATE,
        },
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolveGit() : reject(new Error(`git ${args.join(" ")} exited ${code}`)),
      );
    });
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Parity");
  await git("config", "user.email", "parity@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("add", "tracked.txt");
  await git("commit", "-m", "seed");
}

const root = await mkdtemp(join(tmpdir(), "nmi-cli-parity-"));
const harness = new RuntimeHarness(root);
const steps = only ? PLAN.filter((step) => step.name.includes(only)) : PLAN;
let failures = 0;

try {
  const runtimes: Runtime[] = [];
  // Every process here runs from a throwaway workspace, so a candidate given
  // as `./target/debug/nomoreide` would resolve against that directory and
  // vanish. Absolutised once, against the shell's cwd, before anything spawns.
  const candidate = candidateSpec(argv);
  const absolute = { ...candidate, command: resolve(process.cwd(), candidate.command) };
  for (const spec of [referenceSpec(), absolute]) {
    runtimes.push(
      await harness.provision(
        spec,
        () => ({ version: 1, services: [], bundles: [], databases: [], gitRepositories: [] }),
        () => workspaceFiles(),
      ),
    );
  }
  // Started up front so the daemon-backed steps find one, and started from the
  // runtime's own workspace so a service's relative `cwd` resolves there.
  for (const runtime of runtimes) {
    await seedRepository(runtime.workspace);
    await harness.startDaemon(runtime, {}, runtime.workspace);
  }
  const [reference, candidateRuntime] = runtimes;

  for (const step of steps) {
    // Sequential per runtime: the plan is a walk, and two `add` commands
    // racing on one config file would interleave differently on each side.
    const referenceRun = await invoke(reference, step, harness);
    const candidateRun = await invoke(candidateRuntime, step, harness);
    const pair = {
      reference: compare(step, referenceRun, runtimes),
      candidate: compare(step, candidateRun, runtimes),
    };
    if (dump) {
      console.log(`--- ${step.name} ---`);
      console.log(`  reference: ${inspect(pair.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(pair.candidate, { depth: null })}`);
    }
    const pin = PINNED.find((entry) => entry.step === step.name);
    if (pin) {
      try {
        assert.deepStrictEqual(pair.reference, pin.reference);
        assert.deepStrictEqual(pair.candidate, pin.candidate);
        console.log(`pin  ${step.name}`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${step.name}  (pinned divergence no longer holds)`);
        console.log(`  why:       ${pin.why}`);
        console.log(`  reference: ${inspect(pair.reference, { depth: null })}`);
        console.log(`  candidate: ${inspect(pair.candidate, { depth: null })}`);
        console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    try {
      assert.deepStrictEqual(pair.candidate, pair.reference);
      console.log(`ok   ${step.name}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${step.name}`);
      console.log(`  args:      nomoreide ${step.args.join(" ")}`);
      console.log(`  reference: ${inspect(pair.reference, { depth: null })}`);
      console.log(`  candidate: ${inspect(pair.candidate, { depth: null })}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\ncli parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log(`\ncli parity: ${steps.length} cases match`);
