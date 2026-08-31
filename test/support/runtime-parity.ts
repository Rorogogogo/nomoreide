/**
 * Black-box harness for the Phase 2 exit gate.
 *
 * Runs the TypeScript reference and a candidate binary side by side against
 * identical, throwaway fixture homes and compares what each one reports
 * through MCP. Nothing here reads either implementation: a stage drives both
 * runtimes with the same tool calls and the payloads are diffed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { callMcpTool, normalizeMcpContract, type McpCommand } from "./mcp-contract.js";
import {
  parityMode,
  Recorder,
  startRecordingProxy,
  startReplayServer,
  type ParityMode,
} from "./parity-recording.js";

export interface RuntimeSpec {
  /** Label used in failure output: "reference" or "candidate". */
  readonly label: string;
  /** Executable plus the arguments that precede the subcommand. */
  readonly command: string;
  readonly args: string[];
}

export interface Runtime extends RuntimeSpec {
  readonly home: string;
  readonly workspace: string;
  readonly port: number;
}

/** A file planted in a runtime's workspace before the daemon boots. */
export interface WorkspaceFile {
  readonly path: string;
  readonly contents: string;
  readonly executable?: boolean;
}

/**
 * There is no reference any more.
 *
 * `src/` was the TypeScript implementation these gates diffed the native
 * binary against, and it has been deleted — the port is finished, and it was
 * the record/replay work that made deleting it possible. Every recording in
 * `test/expectations/` is what the reference answered while it still existed,
 * and replay is now the only mode.
 *
 * Recovering it, should a gate ever need re-recording, means checking out a
 * commit that still has `src/` — the deletion commit's parent — and recording
 * there. That is deliberately awkward: a recording is a historical artefact
 * now, not something to regenerate casually.
 */
const REFERENCE_IS_DELETED =
  "the TypeScript reference was deleted when the port finished; only replay mode exists";

/**
 * A command that cannot exist, used as the reference in replay mode.
 *
 * Replay's whole claim is that the TypeScript runtime is never started — that
 * is what lets `src/` be deleted. Pointing the reference at a path that cannot
 * resolve turns that claim into something the suite enforces rather than
 * something a comment asserts: any code path that still tries to spawn it dies
 * immediately with ENOENT, naming itself.
 */
const UNSPAWNABLE_REFERENCE = "/nonexistent/the-typescript-reference-must-not-run-in-replay";

export function referenceSpec(): RuntimeSpec {
  if (parityMode() !== "replay") {
    // Thrown rather than left to fail at spawn time: "ENOENT
    // /nonexistent/..." is a puzzle, and the answer — that live and record
    // modes died with `src/` — is worth saying outright.
    throw new Error(
      `${REFERENCE_IS_DELETED}. Run the gates with --replay (or ` +
        `NOMOREIDE_PARITY_MODE=replay); \`npm run parity -- <binary> --replay\`.`,
    );
  }
  return { label: "reference", command: UNSPAWNABLE_REFERENCE, args: [] };
}

export function candidateSpec(argv: string[]): RuntimeSpec {
  if (argv.length === 0) {
    throw new Error("A candidate command is required");
  }
  return { label: "candidate", command: argv[0], args: argv.slice(1) };
}

export class RuntimeHarness {
  readonly #root: string;
  readonly #runtimes: Runtime[] = [];
  readonly #daemons: ChildProcess[] = [];
  readonly #stderr = new Map<ChildProcess, () => string>();

  /**
   * Record/replay state. All of it is inert in `live` mode, which is still the
   * default and still the strongest check — the recording exists so the gates
   * keep working after `src/` is deleted, not instead of running them now.
   */
  readonly #recorder: Recorder;
  readonly #mode: ParityMode;
  readonly #servers: Server[] = [];

  /**
   * `gate` names the recording, and defaults to the script being run — which
   * is what every gate wants. A gate that stands up more than one pair of
   * daemons names each pair itself: two harnesses sharing a recording would
   * write over each other, and on the way back a request could be answered
   * with the other pair's reply, since replay matches on method and path.
   */
  constructor(root: string, gate?: string) {
    this.#root = root;
    this.#recorder = new Recorder(gate);
    this.#mode = this.#recorder.mode;
  }

  /** Which of the three modes this run is in, for a gate that wants to say so. */
  get mode(): ParityMode {
    return this.#mode;
  }

  /**
   * True when this runtime's answers come from a recording rather than a
   * process. Only ever the reference: the candidate is the thing under test
   * and always runs for real.
   */
  replayed(runtime: Runtime): boolean {
    return this.#recorder.isReplayed(runtime.label);
  }

  get runtimes(): readonly Runtime[] {
    return this.#runtimes;
  }

  /**
   * Give one runtime a private home, workspace, and daemon port. The config is
   * rendered per runtime so `{{workspace}}` and `{{node}}` resolve to that
   * runtime's own paths; normalization maps them back to a shared placeholder.
   */
  async provision(
    spec: RuntimeSpec,
    renderConfig: (runtime: Omit<Runtime, "port">) => unknown,
    files: (runtime: Omit<Runtime, "port">) => WorkspaceFile[],
  ): Promise<Runtime> {
    const home = join(this.#root, spec.label);
    const workspace = join(home, "workspace");
    const partial = { ...spec, home, workspace };
    await mkdir(join(home, ".config", "nomoreide"), { recursive: true });
    await mkdir(workspace, { recursive: true });

    for (const file of files(partial)) {
      const target = join(workspace, file.path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, file.contents);
      if (file.executable) await chmod(target, 0o755);
    }
    await writeFile(
      join(home, ".config", "nomoreide", "config.json"),
      `${JSON.stringify(renderConfig(partial), null, 2)}\n`,
    );

    const runtime: Runtime = { ...partial, port: await availablePort() };
    this.#runtimes.push(runtime);
    return runtime;
  }

  env(runtime: Runtime, overrides: Record<string, string> = {}): Record<string, string> {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    return {
      ...inherited,
      HOME: runtime.home,
      XDG_CONFIG_HOME: join(runtime.home, ".config"),
      NOMOREIDE_AUTO_UI: "0",
      NOMOREIDE_DAEMON_PORT: String(runtime.port),
      // Both runtimes open a terminal with whatever `$SHELL` says, so without
      // this a gate reports the shell of whoever ran it — `/bin/zsh` on one
      // machine, `/bin/bash` on another — and a recording of that answer is
      // only replayable back where it was made. Which shell it is was never
      // the thing under test; that the two runtimes agree about it is.
      SHELL: "/bin/bash",
      ...overrides,
    };
  }

  /**
   * Boot a runtime's daemon and wait until its own state file answers
   * /api/health.
   *
   * `cwd` defaults to the repo root. A gate whose endpoints read *project*
   * state — anything under the daemon's own working directory — points it at
   * `runtime.workspace` instead, so the two runtimes get separate project
   * trees rather than sharing this checkout's.
   */
  async startDaemon(
    runtime: Runtime,
    overrides: Record<string, string> = {},
    cwd: string = repoRoot(),
  ): Promise<void> {
    // Replayed: nothing is spawned. The recording answers on the port the
    // gate already knows, and the state the harness waits for is minted here
    // because it describes this run rather than the recorded one.
    if (this.replayed(runtime)) {
      const recording = await this.#recorder.playback();
      const candidateLabel = runtime.label.replace(/^reference/, "candidate");
      const candidate = this.#runtimes.find((entry) => entry.label === candidateLabel);
      const shadowCommand = candidate?.command ?? process.env.NOMOREIDE_PARITY_SHADOW_COMMAND;
      if (!shadowCommand) {
        throw new Error(`Replay could not find ${candidateLabel} to shadow ${runtime.label}`);
      }
      const shadowPort = await availablePort();
      const shadow: Runtime = {
        ...runtime,
        command: shadowCommand,
        args: candidate?.args ?? [],
        port: shadowPort,
      };
      const daemon = spawn(shadow.command, [...shadow.args, "daemon"], {
        cwd,
        env: this.env(shadow, overrides),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      daemon.stderr?.setEncoding("utf8");
      daemon.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      this.#daemons.push(daemon);
      this.#stderr.set(daemon, () => stderr);
      await waitForDaemon(shadow, daemon, () => stderr);
      this.#servers.push(await startReplayServer(runtime, recording.http, shadowPort));
      return;
    }

    // Recorded: the reference moves to a private port and a proxy takes the
    // one the gate uses, so every answer is written down without the gate
    // knowing. The private port is reserved the same way every other one is —
    // an offset would overflow, because the harness hands out ephemeral ports
    // that are already near the top of the range.
    const recording = this.#mode === "record" && this.#recorder.isReference(runtime.label);
    const listenPort = recording ? await availablePort() : runtime.port;
    const daemon = spawn(runtime.command, [...runtime.args, "daemon"], {
      cwd,
      env: this.env(runtime, { ...overrides, NOMOREIDE_DAEMON_PORT: String(listenPort) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    daemon.stderr?.setEncoding("utf8");
    daemon.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    this.#daemons.push(daemon);
    this.#stderr.set(daemon, () => stderr);
    await waitForDaemon(runtime, daemon, () => stderr);
    if (recording) {
      this.#servers.push(
        await startRecordingProxy(runtime, listenPort, this.#recorder.http, (exchange) =>
          this.#recorder.redactBody(exchange),
        ),
      );
    }
  }

  /** Invoke one MCP tool against one runtime in a fresh adapter process. */
  async call(
    runtime: Runtime,
    tool: string,
    args: Record<string, unknown> = {},
    overrides: Record<string, string> = {},
  ): Promise<unknown> {
    return this.recorded(runtime, `tool:${tool}`, () => {
      const command: McpCommand = {
        command: runtime.command,
        args: [...runtime.args, "mcp"],
        cwd: repoRoot(),
        env: this.env(runtime, overrides),
      };
      return callMcpTool(command, tool, args);
    });
  }

  /**
   * Produce one value the way the reference produces it — or, in replay, the
   * way it produced it when this gate was recorded.
   *
   * This is the seam for everything the replay HTTP server cannot stand in
   * for. Most gates need none of it: they reach the reference over HTTP and
   * the replay server answers transparently. The rest reach it some other way
   * — as an MCP process, by draining the vendor stub it made requests to, or
   * (in two gates) by importing its TypeScript directly — and those wrap the
   * reference side in this.
   *
   * The candidate is never recorded or replayed. It is the thing under test,
   * so it always runs for real, in every mode.
   */
  async recorded<T>(runtime: Runtime, key: string, produce: () => Promise<T> | T): Promise<T> {
    return this.#recorder.recorded(runtime, key, produce);
  }

  /**
   * Drain a vendor stub's recorded requests, through the seam above.
   *
   * Twelve gates assert not only what the daemon *answered* but what it *asked
   * a vendor* — that a refused action reached no API, that a cache held, that
   * a token was not attached. Those are among the strongest assertions in the
   * suite and they live in the stub rather than in any response, so they have
   * to survive replay too: in replay the reference makes no requests at all,
   * because there is no reference.
   */
  /** Install a record-time body redactor. See {@link Recorder.redact}. */
  redact(redactor: Parameters<Recorder["redact"]>[0]): void {
    this.#recorder.redact(redactor);
  }

  async takeStub<T>(runtime: Runtime, key: string, stub: { take(): T[] }): Promise<T[]> {
    return this.recorded(runtime, `stub:${key}`, () => stub.take());
  }

  /**
   * Read a server-sent event stream until it goes quiet, then close it.
   *
   * An event stream never ends on its own — these endpoints hold the
   * connection open and heartbeat into it — so the reader stops when nothing
   * has arrived for `idleMs`, or at `totalMs` whichever comes first, and the
   * bytes it saw are the answer. Both runtimes are read the same way, so a
   * stream that opens slower is a divergence rather than a flake: `idleMs` is
   * the quiet *after* the last byte, not a fixed budget.
   *
   * `whileOpen` runs once the response headers have arrived and before the
   * body is drained, which is how a gate tests *live* delivery: trigger the
   * thing that emits, then keep reading and see whether the event lands.
   */
  async readStream(
    runtime: Runtime,
    path: string,
    options: {
      headers?: Record<string, string>;
      idleMs?: number;
      totalMs?: number;
      whileOpen?: () => Promise<void>;
    } = {},
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return this.recorded(runtime, `stream:${path}`, async () => {
    const { headers = {}, idleMs = 750, totalMs = 8000, whileOpen } = options;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), totalMs);
    let status = 0;
    let received: Record<string, string> = {};
    let body = "";
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
        headers,
        signal: controller.signal,
      });
      status = response.status;
      received = Object.fromEntries(response.headers);
      if (whileOpen) await whileOpen();
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          let quiet: NodeJS.Timeout | undefined;
          const idle = new Promise<"idle">((resolve) => {
            quiet = setTimeout(() => resolve("idle"), idleMs);
          });
          // The read outlives a lost race; `cancel` below settles it, and the
          // catch keeps that from surfacing as an unhandled rejection.
          const next = reader.read();
          next.catch(() => undefined);
          const winner = await Promise.race([next, idle]);
          clearTimeout(quiet);
          if (winner === "idle" || winner.done) break;
          body += decoder.decode(winner.value, { stream: true });
        }
        await reader.cancel().catch(() => undefined);
      }
    } catch (error) {
      // An abort is how this reader always ends; anything else is real.
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
      return { status, headers: received, body };
    });
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.#daemons.map(async (daemon) => {
        if (daemon.exitCode !== null) return;
        daemon.kill("SIGTERM");
        await waitForExit(daemon);
      }),
    );
    await Promise.all(
      this.#servers.map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await this.#recorder.finish();
  }
}

/**
 * Erase only what cannot match between two equivalent runs: each runtime's own
 * paths, pids, ports, and wall-clock times. Exit codes, signal names, states,
 * and message text survive so a real divergence still fails.
 */
export function normalizeRuntimePayload(
  value: unknown,
  runtimes: readonly Runtime[],
  volatile: readonly string[] = [],
): unknown {
  const replaced = JSON.parse(JSON.stringify(value)) as unknown;
  const paths = runtimes.flatMap((runtime) => [runtime.workspace, runtime.home]);
  const withPlaceholders = normalizeMcpContract(replaced, { temporaryPaths: paths });
  return stripVolatile(withPlaceholders, new Set([...VOLATILE_KEYS, ...volatile]));
}

/** Keys whose values are elapsed time or host detail rather than behavior. */
const VOLATILE_KEYS = new Set(["uptimeMs", "uptime", "durationMs", "elapsedMs", "hostname"]);

/**
 * `normalizeMcpContract` only reaches a pid held as its own key. Health and
 * context tools also render one into a prose block, where it is just as
 * unrepeatable.
 */
const PROSE_PID = /\bpid: \d+/g;

/**
 * Volatile keys are dropped rather than masked: when a value races, so does
 * whether the key is emitted at all, and a masked value would still compare
 * unequal against an absent one.
 */
function stripVolatile(value: unknown, volatile: ReadonlySet<string>): unknown {
  if (typeof value === "string") return value.replace(PROSE_PID, "pid: <pid>");
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, volatile));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !volatile.has(key))
        .map(([key, child]) => [key, stripVolatile(child, volatile)]),
    );
  }
  return value;
}

/**
 * Accepted divergences, erased narrowly.
 *
 * Three reference behaviors were reviewed and deliberately not reproduced in
 * the native runtime. Rather than skip the steps that expose them — which
 * would blind the gate to everything else those steps cover — each is erased
 * by the narrowest rule that describes it, so every other field still has to
 * match.
 */

/**
 * D3: the reference records a stop twice — once from the exit watcher, which
 * carries the exit code and signal, and once more from `stopService` itself,
 * which carries no `data`. The native runtime records only the authoritative
 * one. Drop the data-less twin wherever it appears.
 */
function dropDuplicateStopEvents(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isDataLessStopEvent(item))
      .map(dropDuplicateStopEvents);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, dropDuplicateStopEvents(child)]),
    );
  }
  if (typeof value === "string") return maskProseVolatility(value);
  return value;
}

function isDataLessStopEvent(item: unknown): boolean {
  if (item === null || typeof item !== "object") return false;
  const event = item as Record<string, unknown>;
  return (
    event.kind === "service.lifecycle" &&
    typeof event.title === "string" &&
    event.title.endsWith(" stopped") &&
    !("data" in event)
  );
}

/**
 * The same duplicate, as rendered into an agent-context timeline block — except
 * prose cannot distinguish it: a lifecycle event renders as its title whether
 * or not it carries `data`. The reference's extra events also consume slots in
 * the fixed-size window these blocks render, so its block starts further along
 * than the candidate's even where the two agree.
 *
 * Both problems are confined to this one rendered block, and every event in it
 * is compared exactly by the `timeline/*` steps. Mask the block and let those
 * steps carry the coverage.
 */
const PROSE_TIMELINE = /Recent timeline:\n(?:- .*\n?)*/;

/**
 * D1 again, leaking into prose: a record the reference collapsed has no pid
 * left to render, so it prints `n/a` where the candidate prints the pid it
 * kept. A service that genuinely never ran prints `n/a` on both sides, so
 * folding the two together cannot mask a real difference.
 */
function maskProseVolatility(text: string): string {
  if (!text.includes("Recent timeline:") && !text.includes("- pid: ")) return text;
  return text
    .replace(PROSE_TIMELINE, "Recent timeline: <compared by the timeline steps>\n")
    .replace(/- pid: n\/a/g, "- pid: <pid>");
}

/**
 * Known non-issue, not a divergence: the stdout and stderr readers race in both
 * runtimes, so events belonging to *different* services can interleave either
 * way. Order within one service is deterministic and still compared; group the
 * events by service with a stable sort so only the cross-service interleaving
 * is neutralized.
 */
function groupEventsByService(value: unknown): unknown {
  if (Array.isArray(value)) {
    const grouped = value.every(
      (item) => item !== null && typeof item === "object" && "service" in (item as object),
    )
      ? [...value].sort((left, right) =>
          String((left as { service: unknown }).service).localeCompare(
            String((right as { service: unknown }).service),
          ),
        )
      : value;
    return grouped.map(groupEventsByService);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, groupEventsByService(child)]),
    );
  }
  return value;
}

/**
 * D2: the reference answers a stop for an unregistered name by inventing a
 * runtime entry and a timeline event for it, which then persist in every later
 * read. The native runtime refuses instead. Remove the invented name from both
 * sides so the services around it still compare.
 */
function dropInventedService(value: unknown, name: string): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !namesService(item, name))
      .map((item) => dropInventedService(item, name));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== name)
        .map(([key, child]) => [key, dropInventedService(child, name)]),
    );
  }
  return value;
}

function namesService(item: unknown, name: string): boolean {
  if (item === null || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  return record.service === name || record.name === name;
}

/**
 * D1: a stop that finds no live child makes the reference replace the whole
 * status record with a bare `{ name, state: "stopped" }`, discarding the exit
 * code, signal, pid, and URL it had just reported. The native runtime carries
 * the record forward. Where the reference collapsed a record, compare only
 * what it kept.
 */
export function reconcileCollapsedRecords(reference: unknown, candidate: unknown): unknown {
  if (isCollapsedRecord(reference) && isRecord(candidate)) {
    const collapsed = reference as { name: string; state: string };
    if (candidate.name === collapsed.name && candidate.state === "stopped") {
      return { name: collapsed.name, state: collapsed.state };
    }
  }
  if (Array.isArray(reference) && Array.isArray(candidate)) {
    return candidate.map((item, index) => reconcileCollapsedRecords(reference[index], item));
  }
  if (isRecord(reference) && isRecord(candidate)) {
    return Object.fromEntries(
      Object.entries(candidate).map(([key, child]) => [
        key,
        reconcileCollapsedRecords(reference[key], child),
      ]),
    );
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCollapsedRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "name" && keys[1] === "state" && value.state === "stopped";
}

/**
 * D4: an ssh service's environment is emitted as shell assignments ahead of
 * `exec`. The reference emits them in the order the config file lists them;
 * the native runtime parses `env` into a hash map and emits them sorted. The
 * assignments themselves are identical, so sort both sides: which variables are
 * exported, and with what quoting, is still compared exactly — only their order
 * is not. `logs/ssh-argv` pins the unsorted text on both sides.
 */
const REMOTE_ASSIGNMENTS = /(&& )((?:[A-Za-z_][A-Za-z0-9_]*='(?:[^']|'\\'')*' )+)(exec )/g;

function sortRemoteAssignments(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(REMOTE_ASSIGNMENTS, (_match, before, assignments, after) => {
      const sorted = String(assignments).trim().split(" ").sort().join(" ");
      return `${before}${sorted} ${after}`;
    });
  }
  if (Array.isArray(value)) return value.map(sortRemoteAssignments);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sortRemoteAssignments(child)]),
    );
  }
  return value;
}

/** Apply every side-independent reconciler to one payload. */
export function reconcile(value: unknown, inventedName: string): unknown {
  return sortRemoteAssignments(
    groupEventsByService(dropInventedService(dropDuplicateStopEvents(value), inventedName)),
  );
}

/** MCP tool results carry their payload as a single JSON text block. */
export function toolPayload(response: unknown): unknown {
  const typed = response as {
    error?: { code: number; message: string };
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  };
  if (typed.error) return { error: typed.error };
  const text = typed.result?.content?.[0]?.text;
  if (typeof text !== "string") return { result: typed.result };
  try {
    return { isError: typed.result?.isError ?? false, payload: JSON.parse(text) };
  } catch {
    return { isError: typed.result?.isError ?? false, text };
  }
}

export function repoRoot(): string {
  return join(import.meta.dirname, "..", "..");
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a test port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDaemon(
  runtime: Runtime,
  daemon: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const statePath = join(runtime.home, ".nomoreide", "daemon.json");
  // Generous because the reference boots through tsx, which compiles the
  // server on the fly: a cold CI runner is far slower than a warm laptop, and
  // a timeout here would read as a parity failure rather than a slow start.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`${runtime.label} daemon exited during startup: ${stderr().trim()}`);
    }
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as { url?: string };
      if (state.url) {
        const response = await fetch(new URL("/api/health", state.url));
        if (response.ok) return;
      }
    } catch {
      // State is published only once the listener is bound.
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for the ${runtime.label} daemon: ${stderr().trim()}`);
}

async function waitForExit(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      daemon.kill("SIGKILL");
      resolve();
    }, 3_000);
    daemon.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
