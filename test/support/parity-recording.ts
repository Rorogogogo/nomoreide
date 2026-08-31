/**
 * Record and replay the TypeScript reference, so the parity gates outlive it.
 *
 * Every gate in `scripts/` works by launching the reference beside the native
 * binary and diffing what the two answer. That is the right design while both
 * exist, and it is exactly why Phase 8 has been stuck: deleting `src/` — the
 * whole point of the phase — deletes the thing 59 gates measure against, and a
 * suite that cannot run is not a suite.
 *
 * This module breaks that dependency without weakening the gates. Three modes,
 * chosen by `NOMOREIDE_PARITY_MODE`:
 *
 * * **`live`** (default) — unchanged. Both runtimes run, and the gate diffs
 *   them. This is still the strongest check and stays the default while the
 *   reference exists.
 * * **`record`** — the reference runs behind a proxy that writes everything it
 *   answered into `test/expectations/<gate>.json`.
 * * **`replay`** — the reference is not started at all. The recording answers
 *   in its place, and the gate cannot tell the difference.
 *
 * A recording is therefore not a weaker gate — it is the *same* gate with the
 * reference's answers frozen at the commit that recorded them. What it loses
 * is the ability to notice the reference changing, which after `src/` is
 * deleted is not a thing that can happen.
 *
 * ## Why the answers are tokenised
 *
 * A recording is made in one temporary directory on one machine and replayed in
 * another, so any answer naming a path, a port, or the Node binary would be
 * wrong the moment it was replayed. Recording rewrites those to tokens and
 * replay substitutes the current run's values back in, which puts the gate's
 * own normalisation — which maps them straight back to placeholders — in front
 * of exactly the text it expects.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Runtime } from "./runtime-parity.js";

export type ParityMode = "live" | "record" | "replay";

/**
 * What a gate exits with to say it cannot run here — the runner reports it as
 * skipped rather than failed. Mirrored in `scripts/run-parity-gates.ts`.
 */
export const SKIPPED_EXIT = 3;

/**
 * `git --version`, for a gate whose recording is bound to it.
 *
 * Read through the same `git` the gate and the daemon will use, so what is
 * written down is what actually produced the answers.
 */
export async function gitVersion(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["--version"]);
  return stdout.trim();
}

/** One request the reference answered, as it will be replayed. */
export interface RecordedExchange {
  readonly method: string;
  /** Path plus query, tokenised. */
  readonly path: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  /** Body as text, tokenised. Binary bodies are base64 with `base64: true`. */
  readonly body: string;
  readonly base64?: boolean;
}

/**
 * Anything else the reference produced, in the order it produced it.
 *
 * Not every gate reaches the reference over HTTP. Some drive it as an MCP
 * process, some drain a vendor stub to see what it *asked* rather than what it
 * answered, and two import it in-process and call TypeScript functions
 * directly. All of those go through one keyed list rather than three shapes,
 * because the difference between them is how the value was obtained and the
 * recording only cares what it was.
 *
 * The `key` is not a lookup — entries are consumed in order — it is a
 * tripwire. A gate whose steps were reordered or renamed since it was recorded
 * would otherwise replay the wrong answers and either pass or fail for a
 * reason nobody could see; instead it stops and says to re-record.
 */
export interface RecordedEntry {
  readonly key: string;
  readonly value: unknown;
}

export interface Recording {
  /** Bumped when the on-disk shape changes, so a stale file fails loudly. */
  readonly version: 1;
  readonly gate: string;
  /**
   * Host facts this recording is only valid against, by name.
   *
   * Some gates compare a tool's own words — the usage `git diff` prints when
   * it is handed a bad flag, for instance — and those words change between
   * versions of the tool. That comparison is worth keeping: it is what says
   * the port surfaces git's message rather than inventing one that reads
   * about right. But it means the recording is an artefact of one git, and
   * replaying it against another produces a difference that looks like a
   * defect and is not.
   *
   * So the gate says what it is bound to, the value is written down here, and
   * a replay that does not match stops and says which two versions it is
   * caught between. See {@link Recorder.bind}.
   */
  readonly bindings?: Readonly<Record<string, string>>;
  readonly http: RecordedExchange[];
  readonly entries: RecordedEntry[];
}

const WORKSPACE = "%%WORKSPACE%%";
const HOME = "%%HOME%%";
const PORT = "%%PORT%%";
const NODE = "%%NODE%%";
const REPO = "%%REPO%%";
const USER_HOME = "%%USER-HOME%%";
const PID = "%%PID%%";
const PGID = "%%PGID%%";
const VERSION = "%%VERSION%%";

/**
 * The workspace version, which several answers report and `deploy.yml` moves
 * on every release.
 *
 * Left untokenised, a recording stops replaying the moment a version is cut —
 * `0.1.103` became `0.2.0` and two gates failed on nothing but that string,
 * which reads exactly like a port defect. It is not one: both runtimes take
 * the version from the same place, so it can never be what they disagree
 * about, and pinning it into a recording only dates the recording.
 */
function workspaceVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(defaultRoot(), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

/**
 * Anchored to where a version is *reported*, not to the digits.
 *
 * The bare-number lesson from pids applies here too: a loose replacement of
 * `0.2.0` would rewrite any fixture that happened to name that version of
 * something else. These three are every spelling the recordings actually use.
 */
function tokeniseVersion(text: string): string {
  const version = workspaceVersion();
  if (!version) return text;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`("version\\\\?":\\s*\\\\?")${escaped}(\\\\?")`, "g"), `$1${VERSION}$2`)
    .replace(new RegExp(`\\bv${escaped}\\b`, "g"), `v${VERSION}`)
    .replace(new RegExp(`\\bnomoreide@${escaped}\\b`, "g"), `nomoreide@${VERSION}`);
}

/**
 * The gate's own process group, which is not always its pid.
 *
 * A gate started by `run-parity-gates.ts` is detached and so leads its own
 * group, and the two numbers are the same; one started straight from a shell
 * is not, and they differ. Endpoints that report who holds a port report both.
 */
function processGroup(): number {
  return typeof process.getpgid === "function" ? process.getpgid(0) : process.pid;
}

/**
 * Rewrite the gate's own pid and process group, *where a pid is being reported*.
 *
 * Two endpoints name the process holding a port or owning a process tree, and
 * the gate is that process, so its numbers are in the answer and are different
 * every run. They are matched by the place they appear rather than by their
 * value: a bare number is not distinctive, and replacing every one of them
 * corrupts anything that happens to say it — a gate that writes five thousand
 * log lines rewrote `line 4941` the day the pid was 4941.
 */
function tokeniseProcessIds(text: string): string {
  const pid = process.pid;
  const group = processGroup();
  return (
    text
      // A JSON field. `ppid` is the gate too: the daemon reports the parent of
      // a process the gate started.
      .replace(new RegExp(`("(?:pid|ppid)":\\s*)${pid}\\b`, "g"), `$1${PID}`)
      .replace(
        new RegExp(`("pgid":\\s*)${group}\\b`, "g"),
        `$1${group === pid ? PID : PGID}`,
      )
      // And prose: "held by pid 53642 — …", "Process 64080 changed …".
      .replace(new RegExp(`\\b(pid|Process) ${pid}\\b`, "g"), `$1 ${PID}`)
  );
}
const WORKSPACE_SLUG = "%%WORKSPACE-SLUG%%";
const HOME_SLUG = "%%HOME-SLUG%%";

/**
 * A directory as Claude Code names it when it flattens one into a single path
 * segment: separators and whitespace become dashes.
 *
 * A path can therefore reach a recording in a spelling no substitution of the
 * path itself would find — `~/.claude/projects/-var-folders-…-workspace` names
 * the workspace without containing it. Left alone it is the one string in an
 * answer that still says which directory the *recording* was made in.
 */
function slug(path: string): string {
  return path.replace(/[/\\]/g, "-").replace(/\s+/g, "-");
}

/** What {@link volatile} has been told about, in the order it was told. */
const volatiles: string[] = [];

/**
 * Register a string this run minted that a recording must not keep.
 *
 * Most of what varies between two runs is a runtime's own home, workspace, or
 * port, and those are known here. The rest belongs to the *gate*: an OAuth
 * stub listening on an ephemeral port, a fixture repository cloned from a
 * directory outside either runtime's tree. Those are tokenised by position —
 * the same gate registers the same things in the same order every run, so
 * index `n` at replay is the thing index `n` was at record time.
 *
 * Registration must happen before the value can reach an answer, which in
 * practice means as soon as the gate knows it.
 */
export function volatile(value: string): void {
  volatiles.push(value);
}

function volatileToken(index: number): string {
  return `%%VOLATILE-${index}%%`;
}

function tokeniseVolatiles(text: string): string {
  // Longest first, so one registered value that contains another is replaced
  // whole rather than partly.
  return [...volatiles.entries()]
    .sort(([, left], [, right]) => right.length - left.length)
    .reduce((current, [index, value]) => {
      if (value.length === 0) return current;
      // A bare number — a port — is matched on a boundary, so it is not found
      // inside a longer one.
      return /^\d+$/.test(value)
        ? current.replace(new RegExp(`\\b${value}\\b`, "g"), volatileToken(index))
        : current.split(value).join(volatileToken(index));
    }, text);
}

function detokeniseVolatiles(text: string): string {
  return volatiles.reduce(
    (current, value, index) => current.split(volatileToken(index)).join(value),
    text,
  );
}

export function parityMode(): ParityMode {
  const raw = process.env.NOMOREIDE_PARITY_MODE;
  if (raw === "record" || raw === "replay") return raw;
  return "live";
}

/**
 * The gate's own name, taken from the script being run.
 *
 * Derived rather than passed so that adding record/replay costs the gates
 * nothing — `scripts/check-extensions-parity.ts` records to
 * `test/expectations/extensions.json` with no argument and no registration.
 */
export function gateName(): string {
  const script = basename(process.argv[1] ?? "unknown");
  return script.replace(/^check-/, "").replace(/-parity\.(ts|js)$/, "");
}

export function expectationsPath(gate: string, root: string): string {
  return join(root, "test", "expectations", `${gate}.json`);
}

export async function readRecording(gate: string, root: string): Promise<Recording> {
  const path = expectationsPath(gate, root);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `No recorded expectations for "${gate}". Record them against the reference first:\n` +
        `  NOMOREIDE_PARITY_MODE=record node --import tsx scripts/check-${gate}-parity.ts <candidate>`,
    );
  }
  const parsed = JSON.parse(raw) as Recording;
  if (parsed.version !== 1) {
    throw new Error(`${path} was written by a different recording format (version ${parsed.version}).`);
  }
  return parsed;
}

export async function writeRecording(recording: Recording, root: string): Promise<string> {
  const path = expectationsPath(recording.gate, root);
  await mkdir(join(root, "test", "expectations"), { recursive: true });
  await writeFile(path, `${JSON.stringify(recording, null, 2)}\n`);
  return path;
}

/** Replace this run's volatile strings with tokens, on the way into a file. */
export function tokenise(text: string, runtime: Runtime): string {
  const withoutPaths = tokeniseVolatiles(text)
    // The checkout itself. Gates run the reference from it and several answers
    // name it, so a recording made here would otherwise only replay in a
    // directory of the same name — and would carry whoever's home directory it
    // sits under into the repository.
    .split(encodeURIComponent(defaultRoot()))
    .join(REPO)
    .split(defaultRoot())
    .join(REPO)
    // The home of whoever is running the suite. A runtime's *fixture* home is
    // already tokenised above, but an answer can name the real one — the
    // directory the checkout sits in, an agent binary found on PATH — and that
    // is both unportable and nobody else's business.
    .split(homedir())
    .join(USER_HOME)
    .split(encodeURIComponent(runtime.workspace))
    .join(WORKSPACE)
    .split(encodeURIComponent(runtime.home))
    .join(HOME)
    // Slugs first: a slugged path shares no substring with the plain one, but
    // replacing the plain one first would leave a token *inside* a slug.
    .split(slug(runtime.workspace))
    .join(WORKSPACE_SLUG)
    .split(slug(runtime.home))
    .join(HOME_SLUG)
    .split(runtime.workspace)
    .join(WORKSPACE)
    .split(runtime.home)
    .join(HOME)
    .split(process.execPath)
    .join(NODE);
  const stable = tokeniseVersion(tokeniseProcessIds(withoutPaths));
  // In-process gates have no daemon port and use 0 as the sentinel. Replacing
  // every zero would corrupt arbitrary JSON numbers before it can be parsed.
  if (runtime.port <= 0) return stable;
  return stable
    .split(encodeURIComponent(String(runtime.port)))
    .join(PORT)
    .split(String(runtime.port))
    .join(PORT);
}

/** Put this run's values back, on the way out of a file. */
export function detokenise(text: string, runtime: Runtime): string {
  return detokeniseVolatiles(text)
    .split(REPO)
    .join(defaultRoot())
    .split(USER_HOME)
    .join(homedir())
    .split(WORKSPACE_SLUG)
    .join(slug(runtime.workspace))
    .split(HOME_SLUG)
    .join(slug(runtime.home))
    .split(WORKSPACE)
    .join(runtime.workspace)
    .split(HOME)
    .join(runtime.home)
    .split(PORT)
    .join(String(runtime.port))
    .split(NODE)
    .join(process.execPath)
    .split(PGID)
    .join(String(processGroup()))
    .split(PID)
    .join(String(process.pid))
    // Back to whatever the version is *now*, which is the point: the recording
    // stops carrying the version it was made at, so cutting a release no
    // longer invalidates it.
    .split(VERSION)
    .join(workspaceVersion());
}

/** The same, for a parsed value — used for MCP results, which are JSON. */
export function tokeniseValue(value: unknown, runtime: Runtime): unknown {
  return JSON.parse(tokenise(JSON.stringify(value ?? null), runtime)) as unknown;
}

export function detokeniseValue(value: unknown, runtime: Runtime): unknown {
  return JSON.parse(detokenise(JSON.stringify(value ?? null), runtime)) as unknown;
}

/**
 * Headers a recording must not keep.
 *
 * All of these describe the *transport* of one particular response rather than
 * anything the gate is testing. `transfer-encoding` is the one that bites: the
 * reference streams a chunked body, replay sends a fixed-length one, and
 * replaying the header alongside a `content-length` produces a response whose
 * framing contradicts itself — the chunk terminator ends up inside the body.
 * `date` and `content-length` are regenerated, and an `etag` minted for one run
 * means nothing in another. Everything else is kept, because a gate that
 * asserts a content type is asserting a contract.
 */
const VOLATILE_HEADERS = new Set([
  "date",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "etag",
]);

function keepHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || VOLATILE_HEADERS.has(key.toLowerCase())) continue;
    kept[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return kept;
}

/**
 * A proxy that stands where the reference daemon would and writes down
 * everything it says.
 *
 * The reference is moved to a private port and this listens on the one the
 * gate knows about, so the gate's own `fetch` calls are recorded without the
 * gate being aware of it.
 */
export async function startRecordingProxy(
  runtime: Runtime,
  upstreamPort: number,
  sink: RecordedExchange[],
  redact: (exchange: RecordedExchange) => string = (exchange) => exchange.body,
): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const forwarded = httpRequest(
        {
          host: "127.0.0.1",
          port: upstreamPort,
          method: incoming.method,
          path: incoming.url,
          // Preserve the public Host header. Some routes build loopback URLs
          // from it, and the recording proxy must be transparent rather than
          // leaking the reference daemon's private upstream port.
          headers: incoming.headers,
        },
        (answer) => {
          const answerChunks: Buffer[] = [];
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.on("data", (chunk: Buffer) => {
            answerChunks.push(chunk);
            outgoing.write(chunk);
          });
          answer.on("end", () => {
            outgoing.end();
            const payload = Buffer.concat(answerChunks);
            const text = payload.toString("utf8");
            // A body that does not survive a UTF-8 round trip is binary, and
            // is kept as base64 rather than corrupted into replacement
            // characters.
            const binary = Buffer.from(text, "utf8").length !== payload.length;
            const exchange: RecordedExchange = {
              method: incoming.method ?? "GET",
              path: tokenise(incoming.url ?? "/", runtime),
              status: answer.statusCode ?? 502,
              headers: keepHeaders(answer.headers),
              // A redactor is handed the body as the daemon wrote it and is
              // tokenised afterwards. Tokenising first would hand it text that
              // is no longer JSON — a pid token stands where a number was —
              // and every redactor would have to cope with that to do its job.
              body: binary
                ? payload.toString("base64")
                : tokenise(
                    redact({
                      method: incoming.method ?? "GET",
                      path: tokenise(incoming.url ?? "/", runtime),
                      status: answer.statusCode ?? 502,
                      headers: keepHeaders(answer.headers),
                      body: text,
                    }),
                    runtime,
                  ),
              ...(binary ? { base64: true } : {}),
            };
            sink.push(exchange);
          });
        },
      );
      forwarded.on("error", () => {
        outgoing.writeHead(502).end();
      });
      forwarded.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.port, "127.0.0.1", resolve);
  });
  return server;
}

/**
 * A server that answers from a recording, in the order it was recorded.
 *
 * Matching is by method and path, scanning forward from a cursor rather than
 * taking the next entry outright: the harness's own readiness polling hits
 * `/api/health` an unpredictable number of times, and a strict sequence would
 * desynchronise on the first extra probe. Scanning forward keeps a walk's
 * repeated reads of one path in order — the second `GET /api/status` gets the
 * second recorded answer — which is the property the walks depend on.
 *
 * A request with nothing left to match is answered `599` with the reason in
 * the body. That is deliberately not a plausible status: a gate that silently
 * compared two 404s would hide a recording that had run dry.
 */
export async function startReplayServer(
  runtime: Runtime,
  recording: readonly RecordedExchange[],
  shadowPort?: number,
): Promise<Server> {
  const used = new Set<number>();
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
      const method = incoming.method ?? "GET";
      const path = tokenise(incoming.url ?? "/", runtime);
      const index = recording.findIndex(
        (entry, at) => !used.has(at) && entry.method === method && entry.path === path,
      );
      if (index < 0) {
        outgoing
          .writeHead(599, { "content-type": "text/plain" })
          .end(`No recorded answer for ${method} ${path}`);
        return;
      }
      // Replay freezes what the reference answered, but stateful gates also
      // inspect what its request changed on disk or in a process. Apply the
      // same request to a native shadow using the reference fixture, discard
      // that answer, then serve the recorded bytes. No TypeScript is involved.
      if (shadowPort !== undefined) {
        await forwardToShadow(incoming, Buffer.concat(chunks), shadowPort);
      }
      used.add(index);
      const entry = recording[index];
      const body = entry.base64
        ? Buffer.from(entry.body, "base64")
        : Buffer.from(detokenise(entry.body, runtime), "utf8");
      outgoing.writeHead(entry.status, { ...entry.headers, "content-length": String(body.length) });
      outgoing.end(body);
      })().catch((error) => {
        outgoing.writeHead(502, { "content-type": "text/plain" });
        outgoing.end(`Replay shadow failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.port, "127.0.0.1", resolve);
  });
  return server;
}

function forwardToShadow(
  incoming: import("node:http").IncomingMessage,
  body: Buffer,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const forwarded = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (answer) => {
        answer.resume();
        answer.on("end", resolve);
      },
    );
    forwarded.on("error", reject);
    forwarded.end(body);
  });
}

/**
 * Publish the state a replayed daemon would have written.
 *
 * The harness waits for `daemon.json` before it lets a gate proceed, and
 * several gates read the credential to authorise their own requests. Neither
 * comes from the recording — they describe *this* run — so they are minted
 * here. The credential is real randomness rather than a fixed string so that
 * nothing can come to depend on its value.
 */
export async function publishReplayState(runtime: Runtime): Promise<void> {
  const directory = join(runtime.home, ".nomoreide");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "daemon.json"),
    `${JSON.stringify(
      {
        pid: process.pid,
        ownerId: randomBytes(16).toString("hex"),
        url: `http://127.0.0.1:${runtime.port}`,
        port: runtime.port,
        version: "replay",
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(directory, "daemon.credential"), `${randomBytes(32).toString("hex")}\n`);
}


/**
 * The record/replay bookkeeping, on its own so that gates which do not use
 * `RuntimeHarness` can still be replayed.
 *
 * Three of the MCP gates build their runtimes by hand and drive the reference
 * as a process directly. They get no HTTP replay because they make no HTTP
 * requests — but they still have a reference to stand in for, so they hold one
 * of these and wrap the reference side of each step in {@link Recorder.recorded}.
 */
export class Recorder {
  readonly mode: ParityMode = parityMode();
  readonly gate: string;
  readonly #root: string;
  readonly http: RecordedExchange[] = [];
  readonly #bindings: Record<string, string> = {};
  readonly #redactors: Array<(exchange: RecordedExchange) => string | undefined> = [];
  readonly #entries: RecordedEntry[] = [];
  #playback: Recording | undefined;
  #cursor = 0;

  constructor(gate: string = gateName(), root: string = defaultRoot()) {
    this.gate = gate;
    this.#root = root;
  }

  /**
   * Rewrite a body on its way into the recording.
   *
   * A recording is a file in the repository, and some answers are a picture of
   * the machine that made them — `/api/metrics?includeProcesses=1` returns
   * every process on the box, with its user and its full command line. That
   * gate compares the answer's *shape*, and a shape collapses an array to
   * `<array>`, so the rows are never compared by anything: storing them would
   * publish a stranger's process table to buy nothing.
   *
   * A redactor returns the body to store, or `undefined` to leave it alone.
   * It runs only while recording; replay serves whatever was stored.
   */
  redact(redactor: (exchange: RecordedExchange) => string | undefined): void {
    this.#redactors.push(redactor);
  }

  /** Apply the installed redactors, longest-standing first. */
  redactBody(exchange: RecordedExchange): string {
    return this.#redactors.reduce(
      (body, redact) => redact({ ...exchange, body }) ?? body,
      exchange.body,
    );
  }

  /**
   * Declare a host fact this gate's recording is only valid against.
   *
   * Recording stores the value; replaying re-reads it and compares. A gate
   * that binds `git` to `git version 2.51.0` and is replayed where git is
   * 2.39.3 does not report a divergence — it reports that it cannot make the
   * comparison here, by exiting {@link SKIPPED_EXIT}, which the runner shows
   * as skipped and `--allow-skips` lets pass.
   *
   * Live mode ignores bindings entirely: both runtimes are calling the same
   * git on the same machine, which is exactly why the comparison is sound
   * there and worth keeping unnormalised.
   */
  async bind(name: string, value: string): Promise<void> {
    if (this.mode === "record") {
      this.#bindings[name] = value;
      return;
    }
    if (this.mode !== "replay") return;
    const recorded = (await this.playback()).bindings?.[name];
    if (recorded === undefined || recorded === value) return;
    console.log(
      `skipped: this recording is bound to ${name} "${recorded}" and this machine has "${value}".\n` +
        `  The gate compares that tool's own output, which differs between versions — a mismatch\n` +
        `  here is the tool, not the port. Run it live, or re-record:\n` +
        `    npm run parity -- <candidate> --only check-${this.gate}-parity.ts --record`,
    );
    process.exit(SKIPPED_EXIT);
  }

  /** Whether this side's answers come from the recording rather than a process. */
  isReplayed(label: string): boolean {
    return this.mode === "replay" && this.isReference(label);
  }

  /** Multi-pass gates suffix the role with a scenario name for diagnostics. */
  isReference(label: string): boolean {
    return label === "reference" || label.startsWith("reference-");
  }

  async playback(): Promise<Recording> {
    this.#playback ??= await readRecording(this.gate, this.#root);
    return this.#playback;
  }

  /**
   * Produce one value the reference's way, or replay the one it produced when
   * this gate was recorded. The candidate always runs for real.
   */
  async recorded<T>(
    runtime: Runtime,
    key: string,
    produce: () => Promise<T> | T,
  ): Promise<T> {
    if (this.isReplayed(runtime.label)) {
      const recording = await this.playback();
      const entry = recording.entries[this.#cursor];
      this.#cursor += 1;
      if (!entry) {
        throw new Error(
          `The recording of "${this.gate}" ran out at "${key}". Re-record it against the reference.`,
        );
      }
      if (entry.key !== key) {
        throw new Error(
          `The recording of "${this.gate}" is out of step: expected "${entry.key}", got "${key}". ` +
            "The plan changed since it was recorded — re-record it.",
        );
      }
      return detokeniseValue(entry.value, runtime) as T;
    }
    const value = await produce();
    if (this.mode === "record" && this.isReference(runtime.label)) {
      this.#entries.push({ key, value: tokeniseValue(value, runtime) });
    }
    return value;
  }

  /** Write the recording, if this run was making one. Safe to call always. */
  async finish(): Promise<void> {
    if (this.mode !== "record") return;
    const path = await writeRecording(
      {
        version: 1,
        gate: this.gate,
        ...(Object.keys(this.#bindings).length > 0 ? { bindings: this.#bindings } : {}),
        http: this.http,
        entries: this.#entries,
      },
      this.#root,
    );
    console.log(
      `\nrecorded ${this.http.length} exchange(s) and ${this.#entries.length} other value(s) -> ${path}`,
    );
  }
}

/** The repository root, without importing the harness and creating a cycle. */
function defaultRoot(): string {
  return join(import.meta.dirname, "..", "..");
}
