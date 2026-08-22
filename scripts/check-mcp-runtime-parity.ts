/**
 * Phase 2 exit gate: a clean-machine black-box suite proving the TypeScript
 * reference and the native binary report equivalent service states, logs,
 * health, and errors.
 *
 * Both runtimes get a private throwaway home, an identical service config, and
 * the same ordered sequence of MCP calls. Only values that cannot match between
 * two equivalent runs (pids, ports, wall-clock times, each runtime's own paths)
 * are normalized away; states, exit codes, signal names, and message text are
 * compared verbatim.
 *
 * Usage:
 *   node --import tsx scripts/check-mcp-runtime-parity.ts ./target/debug/nomoreide
 *   node --import tsx scripts/check-mcp-runtime-parity.ts --dump ./target/debug/nomoreide
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { join } from "node:path";
import {
  candidateSpec,
  delay,
  normalizeRuntimePayload,
  reconcile,
  reconcileCollapsedRecords,
  referenceSpec,
  repoRoot,
  RuntimeHarness,
  toolPayload,
  type Runtime,
  type RuntimeSpec,
  type WorkspaceFile,
} from "../test/support/runtime-parity.js";

interface Step {
  readonly name: string;
  readonly tool: string;
  readonly args?: Record<string, unknown>;
  /** Milliseconds to wait after this call so the next step observes a settled runtime. */
  readonly settle?: number;
  /**
   * Fields this step cannot compare. A service's URL is parsed out of its
   * stdout asynchronously, so whether a *start* call returns before or after
   * that line arrives is a race in both runtimes. The `status` step that
   * follows each start compares the URL once it has settled.
   */
  readonly volatile?: readonly string[];
}

/**
 * One ordered walk covering every state a service can be in, the reads taken
 * against each state, and the refusals. Both runtimes execute it identically.
 */
const PLAN: Step[] = [
  { name: "discovery", tool: "nomoreide_list_services" },
  { name: "status/before-any-start", tool: "nomoreide_status" },
  { name: "health/never-run", tool: "nomoreide_service_health", args: { service: "idle" } },
  { name: "logs/never-run", tool: "nomoreide_read_logs", args: { name: "idle" } },
  { name: "context/never-run", tool: "nomoreide_service_context", args: { name: "idle" } },
  { name: "timeline/before-any-start", tool: "nomoreide_timeline" },

  { name: "start/banner", tool: "nomoreide_start_service", args: { name: "banner" }, settle: 1_500, volatile: ["url"] },
  { name: "status/running", tool: "nomoreide_status" },
  { name: "logs/running", tool: "nomoreide_read_logs", args: { name: "banner" } },
  { name: "logs/running-limited", tool: "nomoreide_read_logs", args: { name: "banner", limit: 2 } },
  { name: "health/running", tool: "nomoreide_service_health", args: { service: "banner" } },
  { name: "context/running", tool: "nomoreide_service_context", args: { name: "banner" } },
  { name: "start/already-running", tool: "nomoreide_start_service", args: { name: "banner" }, volatile: ["url"] },
  { name: "restart/running", tool: "nomoreide_restart_service", args: { name: "banner" }, settle: 1_500, volatile: ["url"] },
  { name: "status/after-restart", tool: "nomoreide_status" },
  { name: "stop/running", tool: "nomoreide_stop_service", args: { name: "banner" }, settle: 800 },
  { name: "status/stopped-after-running", tool: "nomoreide_status" },
  { name: "health/stopped-after-running", tool: "nomoreide_service_health", args: { service: "banner" } },
  { name: "stop/already-stopped", tool: "nomoreide_stop_service", args: { name: "banner" } },

  { name: "start/quitter", tool: "nomoreide_start_service", args: { name: "quitter" }, settle: 2_000 },
  { name: "status/exited", tool: "nomoreide_status" },
  { name: "logs/exited", tool: "nomoreide_read_logs", args: { name: "quitter" } },
  { name: "health/exited", tool: "nomoreide_service_health", args: { service: "quitter" } },
  { name: "context/exited", tool: "nomoreide_service_context", args: { name: "quitter" } },
  { name: "timeline/exited", tool: "nomoreide_timeline", args: { service: "quitter" } },

  { name: "error/start-unregistered", tool: "nomoreide_start_service", args: { name: "not-registered" } },
  { name: "error/stop-unregistered", tool: "nomoreide_stop_service", args: { name: "not-registered" } },
  { name: "error/logs-unregistered", tool: "nomoreide_read_logs", args: { name: "not-registered" } },
  { name: "error/context-unregistered", tool: "nomoreide_service_context", args: { name: "not-registered" } },
  { name: "error/health-unregistered", tool: "nomoreide_service_health", args: { service: "not-registered" } },
  { name: "error/timeline-unregistered", tool: "nomoreide_timeline", args: { service: "not-registered" } },
  { name: "error/start-unknown-bundle", tool: "nomoreide_start_bundle", args: { name: "not-registered" } },
  { name: "error/stop-unknown-bundle", tool: "nomoreide_stop_bundle", args: { name: "not-registered" } },
  { name: "error/bundle-missing-member", tool: "nomoreide_start_bundle", args: { name: "missing" }, settle: 1_500 },
  { name: "status/after-refused-bundle", tool: "nomoreide_status" },

  { name: "bundle/start", tool: "nomoreide_start_bundle", args: { name: "pair" }, settle: 2_000, volatile: ["url"] },
  { name: "status/bundle-running", tool: "nomoreide_status" },
  { name: "bundle/stop", tool: "nomoreide_stop_bundle", args: { name: "pair" }, settle: 800 },
  { name: "status/bundle-stopped", tool: "nomoreide_status" },

  // An ssh service is a local `ssh` process wrapping a remote command. The
  // stub on PATH keeps the stage hermetic and puts the constructed argv into
  // the service's own logs, so the remote command line is compared too.
  { name: "start/ssh", tool: "nomoreide_start_service", args: { name: "remote" }, settle: 1_500 },
  { name: "status/ssh-running", tool: "nomoreide_status" },
  { name: "logs/ssh-argv", tool: "nomoreide_read_logs", args: { name: "remote" } },
  { name: "health/ssh-running", tool: "nomoreide_service_health", args: { service: "remote" } },
  { name: "context/ssh-running", tool: "nomoreide_service_context", args: { name: "remote" } },
  { name: "stop/ssh", tool: "nomoreide_stop_service", args: { name: "remote" }, settle: 800 },
  { name: "status/ssh-stopped", tool: "nomoreide_status" },

  // A compose service is the one kind with no process of its own: it reports a
  // container id and never an exit code.
  { name: "start/compose", tool: "nomoreide_start_service", args: { name: "composed" }, settle: 1_000 },
  { name: "status/compose-running", tool: "nomoreide_status" },
  { name: "health/compose-running", tool: "nomoreide_service_health", args: { service: "composed" } },
  { name: "context/compose-running", tool: "nomoreide_service_context", args: { name: "composed" } },
  { name: "stop/compose", tool: "nomoreide_stop_service", args: { name: "composed" }, settle: 800 },
  { name: "status/compose-stopped", tool: "nomoreide_status" },
  { name: "timeline/compose", tool: "nomoreide_timeline", args: { service: "composed" } },

  { name: "health/all", tool: "nomoreide_service_health" },
  { name: "timeline/all", tool: "nomoreide_timeline" },
];

/**
 * A stop for this name is a refusal in the native runtime but a success in the
 * reference, which invents a runtime entry for it. `dropInventedService` keeps
 * that invention out of every later read.
 */
const INVENTED_NAME = "not-registered";

/**
 * Accepted divergences that are pinned rather than reconciled: both sides are
 * asserted verbatim, so the gate fails if *either* runtime changes. These are
 * compared before the reconcilers run, so the difference stays visible here
 * even where a reconciler erases it everywhere else.
 */
const PINNED_DIVERGENCES = [
  {
    step: "error/stop-unregistered",
    why: "Stop is a remediation capability, but the reference extends it to names that were never registered, fabricating a runtime entry and a timeline event for what is usually a typo. The native runtime refuses; see require_stop_allowed and its regression test.",
    reference: { isError: false, payload: { name: INVENTED_NAME, state: "stopped" } },
    candidate: {
      isError: true,
      text: `Tool 'nomoreide_stop_service' execution failed: Service "${INVENTED_NAME}" is not registered.`,
    },
  },
  {
    step: "logs/ssh-argv",
    why: "The reference emits an ssh service's environment assignments in config-file order; the native runtime parses env into a hash map and emits them sorted. Same environment, different argv text.",
    reference: sshArgvLog("Z_LAST='z value' A_FIRST='a value'"),
    candidate: sshArgvLog("A_FIRST='a value' Z_LAST='z value'"),
  },
] as const;

/** The two lines the ssh stub prints for one launch, as the log tool returns them. */
function sshArgvLog(assignments: string): unknown {
  return {
    isError: false,
    payload: [
      {
        service: "remote",
        stream: "stdout",
        text: "ssh-stub arg: parity-host",
        timestamp: "<timestamp>",
      },
      {
        service: "remote",
        stream: "stdout",
        text: `ssh-stub arg: cd '/srv/app' && ${assignments} exec npm start`,
        timestamp: "<timestamp>",
      },
    ],
  };
}

const argv = process.argv.slice(2);
const dump = argv.includes("--dump");
const candidateArgv = argv.filter((entry) => entry !== "--dump");
if (candidateArgv.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-runtime-parity.ts [--dump] <candidate-command> [args...]",
  );
}

const fixture = JSON.parse(
  await readFile(join(repoRoot(), "test/fixtures/mcp-runtime-parity-v1.json"), "utf8"),
) as { config: unknown };

const root = await mkdtemp(join(tmpdir(), "nomoreide-runtime-parity-"));
const harness = new RuntimeHarness(root);

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(candidateArgv)] satisfies RuntimeSpec[]) {
    runtimes.push(
      await harness.provision(
        spec,
        (runtime) => render(fixture.config, runtime.workspace),
        () => workspaceFiles(),
      ),
    );
  }

  await Promise.all(
    runtimes.map((runtime) => harness.startDaemon(runtime, stubEnv(runtime))),
  );

  const transcripts = new Map<string, Map<string, unknown>>();
  for (const runtime of runtimes) {
    transcripts.set(runtime.label, await walk(runtime));
  }

  const [reference, candidate] = runtimes;
  const referenceRun = transcripts.get(reference.label)!;
  const candidateRun = transcripts.get(candidate.label)!;

  if (dump) {
    for (const step of PLAN) {
      process.stdout.write(`\n=== ${step.name} ===\n`);
      process.stdout.write(`--- reference\n${format(referenceRun.get(step.name))}\n`);
      process.stdout.write(`--- candidate\n${format(candidateRun.get(step.name))}\n`);
    }
  }

  const divergences: string[] = [];
  for (const step of PLAN) {
    const referenceRaw = normalizeRuntimePayload(
      referenceRun.get(step.name),
      runtimes,
      step.volatile,
    );
    const candidateRaw = normalizeRuntimePayload(
      candidateRun.get(step.name),
      runtimes,
      step.volatile,
    );

    const pin = PINNED_DIVERGENCES.find((entry) => entry.step === step.name);
    if (pin) {
      assertPinned(step, pin, referenceRaw, candidateRaw, divergences);
      continue;
    }

    const expected = reconcile(referenceRaw, INVENTED_NAME);
    const observed = reconcile(candidateRaw, INVENTED_NAME);
    // Only the candidate is folded down, and only where the reference threw
    // information away; every field the reference kept is still compared.
    const actual = reconcileCollapsedRecords(expected, observed);

    try {
      assert.deepStrictEqual(actual, expected);
    } catch {
      divergences.push(
        `\n### ${step.name} (${step.tool})\n--- reference\n${format(expected)}\n--- candidate\n${format(actual)}`,
      );
    }
  }

  if (divergences.length > 0) {
    throw new Error(
      `${divergences.length} of ${PLAN.length} runtime parity steps diverged:${divergences.join("\n")}`,
    );
  }

  process.stdout.write(
    `MCP runtime parity passed (${PLAN.length} steps, ` +
      `${PINNED_DIVERGENCES.length} accepted divergences pinned).\n`,
  );
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

/** An accepted divergence still has to look exactly the way it was accepted. */
function assertPinned(
  step: Step,
  pin: (typeof PINNED_DIVERGENCES)[number],
  reference: unknown,
  candidate: unknown,
  divergences: string[],
): void {
  for (const [label, actual, expected] of [
    ["reference", reference, pin.reference as unknown],
    ["candidate", candidate, pin.candidate as unknown],
  ] as const) {
    try {
      assert.deepStrictEqual(actual, expected);
    } catch {
      divergences.push(
        `\n### ${step.name} (${step.tool}) — accepted divergence changed on the ${label} side` +
          `\nAccepted because: ${pin.why}` +
          `\n--- expected\n${format(expected)}\n--- actual\n${format(actual)}`,
      );
    }
  }
}

async function walk(runtime: Runtime): Promise<Map<string, unknown>> {
  const transcript = new Map<string, unknown>();
  for (const step of PLAN) {
    const response = await harness.call(runtime, step.tool, step.args ?? {}, stubEnv(runtime));
    transcript.set(step.name, toolPayload(response));
    if (step.settle) await delay(step.settle);
  }
  return transcript;
}

/**
 * Put this runtime's stub directory ahead of everything real. `SHELL` matters
 * as much as `PATH`: the native runtime asks the login shell what PATH to give
 * a service, and trusts that answer over the one it inherited.
 */
function stubEnv(runtime: Runtime): Record<string, string> {
  const stubs = join(runtime.workspace, "stubs");
  return {
    PATH: `${stubs}:${process.env.PATH ?? ""}`,
    SHELL: join(stubs, "login-shell"),
  };
}

/** Substitute the per-runtime workspace and node binary into the fixture config. */
function render(config: unknown, workspace: string): unknown {
  const text = JSON.stringify(config)
    .replaceAll("{{workspace}}", jsonSafe(workspace))
    .replaceAll("{{node}}", jsonSafe(process.execPath));
  return JSON.parse(text);
}

function jsonSafe(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Programs the fixture services run. Each write is separated in time so the
 * stdout and stderr readers cannot interleave differently between runtimes.
 */
function workspaceFiles(): WorkspaceFile[] {
  return [
    {
      // `service_path()` builds the native runtime's PATH from the login
      // shell's and appends the inherited one *last*, so a stub reachable only
      // through PATH would lose to a real /usr/local/bin/docker. Answering the
      // one question that lookup asks puts the stub directory first for both
      // runtimes; anything else falls through to a real shell.
      path: "stubs/login-shell",
      executable: true,
      contents: [
        "#!/bin/sh",
        'if [ "$1" = "-lc" ] && [ "$2" = \'printf %s "$PATH"\' ]; then',
        '  printf %s "$(dirname "$0"):$PATH"',
        "  exit 0",
        "fi",
        'exec /bin/sh "$@"',
        "",
      ].join("\n"),
    },
    {
      // Prints the argv it was handed, one entry per line, so the remote
      // command each runtime constructs lands in the service log, then stays
      // alive like a real ssh session.
      path: "stubs/ssh",
      executable: true,
      contents: [
        "#!/bin/sh",
        'for arg in "$@"; do echo "ssh-stub arg: $arg"; done',
        "exec sleep 86400",
        "",
      ].join("\n"),
    },
    {
      // Answers the three compose verbs both runtimes issue. The container id
      // is fixed so the two sides report the same one.
      path: "stubs/docker",
      executable: true,
      contents: [
        "#!/bin/sh",
        'verb=""',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    up|stop|ps|logs) verb="$arg"; break ;;',
        "  esac",
        "done",
        'case "$verb" in',
        '  ps) echo \'{"ID":"parity-container-id","State":"running"}\' ;;',
        '  logs) echo "compose-stub logs" ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    },
    { path: "compose.yml", contents: "services:\n  web: {}\n" },
    {
      path: "banner.js",
      contents: [
        'console.log("banner: booting");',
        'setTimeout(() => console.log("banner listening on http://localhost:4599"), 120);',
        'setTimeout(() => console.error("banner: background noise"), 260);',
        "setInterval(() => {}, 1 << 30);",
        "",
      ].join("\n"),
    },
    {
      path: "quitter.js",
      contents: [
        'console.log("quitter: starting");',
        'setTimeout(() => console.error("quitter: giving up"), 120);',
        "setTimeout(() => process.exit(7), 260);",
        "",
      ].join("\n"),
    },
  ];
}

function format(value: unknown): string {
  return inspect(value, { depth: null, colors: false, breakLength: 100, sorted: true });
}
