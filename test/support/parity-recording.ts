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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Runtime } from "./runtime-parity.js";

export type ParityMode = "live" | "record" | "replay";

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
  readonly http: RecordedExchange[];
  readonly entries: RecordedEntry[];
}

const WORKSPACE = "%%WORKSPACE%%";
const HOME = "%%HOME%%";
const PORT = "%%PORT%%";
const NODE = "%%NODE%%";

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
  return text
    .split(runtime.workspace)
    .join(WORKSPACE)
    .split(runtime.home)
    .join(HOME)
    .split(String(runtime.port))
    .join(PORT)
    .split(process.execPath)
    .join(NODE);
}

/** Put this run's values back, on the way out of a file. */
export function detokenise(text: string, runtime: Runtime): string {
  return text
    .split(WORKSPACE)
    .join(runtime.workspace)
    .split(HOME)
    .join(runtime.home)
    .split(PORT)
    .join(String(runtime.port))
    .split(NODE)
    .join(process.execPath);
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
          headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` },
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
            sink.push({
              method: incoming.method ?? "GET",
              path: tokenise(incoming.url ?? "/", runtime),
              status: answer.statusCode ?? 502,
              headers: keepHeaders(answer.headers),
              body: binary ? payload.toString("base64") : tokenise(text, runtime),
              ...(binary ? { base64: true } : {}),
            });
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
): Promise<Server> {
  const used = new Set<number>();
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on("end", () => {
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
      used.add(index);
      const entry = recording[index];
      const body = entry.base64
        ? Buffer.from(entry.body, "base64")
        : Buffer.from(detokenise(entry.body, runtime), "utf8");
      outgoing.writeHead(entry.status, { ...entry.headers, "content-length": String(body.length) });
      outgoing.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.port, "127.0.0.1", resolve);
  });
  return server;
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
  readonly #entries: RecordedEntry[] = [];
  #playback: Recording | undefined;
  #cursor = 0;

  constructor(gate: string = gateName(), root: string = defaultRoot()) {
    this.gate = gate;
    this.#root = root;
  }

  /** Whether this side's answers come from the recording rather than a process. */
  isReplayed(label: string): boolean {
    return this.mode === "replay" && label === "reference";
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
    if (this.mode === "record" && runtime.label === "reference") {
      this.#entries.push({ key, value: tokeniseValue(value, runtime) });
    }
    return value;
  }

  /** Write the recording, if this run was making one. Safe to call always. */
  async finish(): Promise<void> {
    if (this.mode !== "record") return;
    const path = await writeRecording(
      { version: 1, gate: this.gate, http: this.http, entries: this.#entries },
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
