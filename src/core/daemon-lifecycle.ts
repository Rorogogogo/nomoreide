import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appVersion } from "./app-version.js";
import { isPidAlive } from "./service-registry.js";

/**
 * Discovery/spawn of the single machine-global NoMoreIDE daemon (the web
 * server started detached via `nomoreide daemon`). Every session — MCP, CLI,
 * TUI, `nomoreide web` — calls {@link ensureDaemon} and talks HTTP to the
 * winner instead of owning its own ProcessManager, so spawned services
 * survive session exits and are visible everywhere.
 */

export interface DaemonState {
  pid: number;
  url: string;
  port: number;
  version?: string;
  startedAt: string;
}

/** Shape `/api/health` answers with (daemon adds version + pid). */
export interface DaemonHealth {
  version?: string;
  pid?: number;
}

export interface EnsureDaemonResult {
  status: "already_running" | "adopted" | "started";
  url: string;
  port: number;
  /** Daemon pid — 0 when the daemon predates health `pid` reporting. */
  pid: number;
  /** Set when the daemon runs a different nomoreide version than this client. */
  versionWarning?: string;
}

export interface DaemonLifecycleOptions {
  /** Defaults to `~/.nomoreide/daemon.json`. */
  statePath?: string;
  /** Defaults to `NOMOREIDE_DAEMON_PORT` or 4317. */
  port?: number;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Injectable for tests; defaults to detaching `node <entry> daemon`. */
  spawnDaemon?: (entryPath: string, port: number) => void;
  /** Compiled CLI entry (`dist/index.js`); resolved from this module by default. */
  entryPath?: string;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Pid-liveness probe, injectable for tests. */
  isPidAlive?: (pid: number) => boolean;
}

export function defaultDaemonStatePath(): string {
  return join(homedir(), ".nomoreide", "daemon.json");
}

export function resolveDaemonPort(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.NOMOREIDE_DAEMON_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 4317;
}

export async function ensureDaemon(
  options: DaemonLifecycleOptions = {},
): Promise<EnsureDaemonResult> {
  const statePath = options.statePath ?? defaultDaemonStatePath();
  const port = options.port ?? resolveDaemonPort(options.env);
  const fetchFn = options.fetch ?? fetch;
  const pidAlive = options.isPidAlive ?? isPidAlive;
  const url = `http://127.0.0.1:${port}`;

  const state = await readDaemonState(statePath);
  if (state && pidAlive(state.pid)) {
    const probe = await probeDaemon(state.url, fetchFn);
    if (probe.kind === "nomoreide") {
      return {
        status: "already_running",
        url: state.url,
        port: state.port,
        pid: probe.health.pid ?? state.pid,
        versionWarning: versionWarning(probe.health),
      };
    }
  }
  if (state) {
    await rm(statePath, { force: true });
  }

  const probe = await probeDaemon(url, fetchFn);
  if (probe.kind === "nomoreide") {
    return {
      status: "adopted",
      url,
      port,
      pid: probe.health.pid ?? 0,
      versionWarning: versionWarning(probe.health),
    };
  }
  if (probe.kind === "foreign") {
    throw new Error(foreignPortMessage(port));
  }

  const spawnFn = options.spawnDaemon ?? spawnDetachedDaemon;
  spawnFn(resolveEntryPath(options.entryPath), port);

  const timeoutMs = options.pollTimeoutMs ?? 10_000;
  const intervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  // If two sessions raced, the loser's daemon exits on the port conflict and
  // this poll simply adopts whichever daemon won the bind.
  while (Date.now() < deadline) {
    const attempt = await probeDaemon(url, fetchFn);
    if (attempt.kind === "nomoreide") {
      return {
        status: "started",
        url,
        port,
        pid: attempt.health.pid ?? 0,
        versionWarning: versionWarning(attempt.health),
      };
    }
    if (attempt.kind === "foreign") {
      throw new Error(foreignPortMessage(port));
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `NoMoreIDE daemon did not become healthy on port ${port} within ${timeoutMs}ms. ` +
      `Check \`nomoreide daemon\` output or pick another port via NOMOREIDE_DAEMON_PORT.`,
  );
}

export async function readDaemonState(
  statePath: string,
): Promise<DaemonState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as DaemonState;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.port !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

type DaemonProbe =
  | { kind: "nomoreide"; health: DaemonHealth }
  | { kind: "foreign" }
  | { kind: "down" };

/** `nomoreide` when `/api/health` answers with our shape, `foreign` when something else holds the port. */
export async function probeDaemon(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<DaemonProbe> {
  let response: Response;
  try {
    response = await fetchFn(new URL("/api/health", url));
  } catch {
    return { kind: "down" };
  }
  try {
    const body = (await response.json()) as {
      ok?: unknown;
      app?: unknown;
      version?: unknown;
      pid?: unknown;
    };
    if (!response.ok || body.ok !== true || body.app !== "nomoreide") {
      return { kind: "foreign" };
    }
    return {
      kind: "nomoreide",
      health: {
        version: typeof body.version === "string" ? body.version : undefined,
        pid: typeof body.pid === "number" ? body.pid : undefined,
      },
    };
  } catch {
    return { kind: "foreign" };
  }
}

function versionWarning(health: DaemonHealth): string | undefined {
  const clientVersion = appVersion();
  if (!health.version || health.version === clientVersion) return undefined;
  // Never auto-kill on skew — the daemon owns running services.
  return (
    `NoMoreIDE daemon is v${health.version} but this client is v${clientVersion}. ` +
    `Run \`nomoreide daemon restart\` to update it (this stops the services it manages).`
  );
}

function foreignPortMessage(port: number): string {
  return (
    `Port ${port} is held by a process that is not a NoMoreIDE daemon. ` +
    `Stop it or set NOMOREIDE_DAEMON_PORT to use a different port.`
  );
}

function resolveEntryPath(override?: string): string {
  const entryPath =
    override ?? fileURLToPath(new URL("../index.js", import.meta.url));
  if (!existsSync(entryPath)) {
    throw new Error(
      `Cannot find the nomoreide entry point at ${entryPath} to spawn the daemon ` +
        `(running from source? build first or run \`nomoreide daemon\` yourself).`,
    );
  }
  return entryPath;
}

function spawnDetachedDaemon(entryPath: string, port: number): void {
  const child = spawn(process.execPath, [entryPath, "daemon", `--port=${port}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
