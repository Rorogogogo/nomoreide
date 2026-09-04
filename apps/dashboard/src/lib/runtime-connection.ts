import { useSyncExternalStore } from "react";

export type RuntimeConnectionPhase =
  | "initializing"
  | "connected"
  | "reconnecting"
  | "unreachable";

export interface RuntimeConnectionSnapshot {
  phase: RuntimeConnectionPhase;
  consecutiveFailures: number;
  lastReachableAt: number | null;
  lastFailureAt: number | null;
  lastFailedEndpoint: string | null;
  lastError: string | null;
  daemonVersion: string | null;
  daemonPid: number | null;
  lastRecoveryAttempts: number;
  recoveredAt: number | null;
}

interface RuntimeHealthPayload {
  ok: true;
  app: "nomoreide";
  version: string;
  pid: number;
}

const INITIAL_SNAPSHOT: RuntimeConnectionSnapshot = {
  phase: "initializing",
  consecutiveFailures: 0,
  lastReachableAt: null,
  lastFailureAt: null,
  lastFailedEndpoint: null,
  lastError: null,
  daemonVersion: null,
  daemonPid: null,
  lastRecoveryAttempts: 0,
  recoveredAt: null,
};

let snapshot = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();

function emit(next: RuntimeConnectionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getRuntimeConnectionSnapshot(): RuntimeConnectionSnapshot {
  return snapshot;
}

/**
 * Whether the daemon answering this page is the one this page was built for.
 *
 * The daemon prefers dashboard files on disk over the copy embedded in it at
 * compile time, which is what lets a `npm run build` take effect without
 * recompiling Rust. The cost is that an *old* daemon will happily serve a newly
 * built dashboard: the browser then runs new client code against a server two
 * versions behind, and the failures look like ordinary bugs rather than skew.
 * That is not hypothetical — a daemon left running for two days answered
 * `auth_error` for a GitHub account that was connected and working.
 *
 * `ensure` in `nomoreide-daemon-client` already replaces an outdated daemon
 * when it is idle, but only the CLI and MCP paths call it. A browser never
 * does, so this is the only place the skew can be noticed from a tab.
 *
 * `null` while the version is still unknown — a page that accused the daemon of
 * being stale before it had heard from it would flash on every load.
 */
export function getDaemonVersionSkew(
  current: RuntimeConnectionSnapshot = snapshot,
): { daemon: string; client: string } | null {
  const daemon = current.daemonVersion;
  if (!daemon || daemon === __APP_VERSION__) {
    return null;
  }
  return { daemon, client: __APP_VERSION__ };
}

export function subscribeToRuntimeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRuntimeConnection(): RuntimeConnectionSnapshot {
  return useSyncExternalStore(
    subscribeToRuntimeConnection,
    getRuntimeConnectionSnapshot,
    () => INITIAL_SNAPSHOT,
  );
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "Unknown network error";
}

/** Keep only method + pathname; queries can contain paths, searches, or tokens. */
export function sanitizeRuntimeEndpoint(
  url: string,
  method = "GET",
): string | null {
  try {
    const parsed = new URL(url, "http://nomoreide.local");
    if (!parsed.pathname.startsWith("/api/")) return null;
    return `${method.toUpperCase()} ${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** Record useful API context without treating ordinary endpoint errors as offline. */
export function recordRuntimeApiFailure(
  url: string,
  error: unknown,
  method = "GET",
  now = Date.now(),
): void {
  const endpoint = sanitizeRuntimeEndpoint(url, method);
  if (!endpoint) return;
  emit({
    ...snapshot,
    lastError: safeErrorMessage(error),
    lastFailedEndpoint: endpoint,
    lastFailureAt: now,
  });
}

/** A successful dashboard payload proves the backend is usable. */
export function recordRuntimeReachable(now = Date.now()): void {
  const recovered = snapshot.consecutiveFailures >= 2;
  emit({
    ...snapshot,
    phase: "connected",
    consecutiveFailures: 0,
    lastReachableAt: now,
    lastRecoveryAttempts: recovered
      ? snapshot.consecutiveFailures
      : snapshot.lastRecoveryAttempts,
    recoveredAt: recovered ? now : snapshot.recoveredAt,
  });
}

export async function probeRuntimeHealth(options: {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
} = {}): Promise<boolean> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 3_000,
  );

  try {
    const response = await fetcher("/api/health", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GET /api/health failed (${response.status || "no status"}).`);
    }
    const body = (await response.json()) as Partial<RuntimeHealthPayload>;
    if (
      body.ok !== true ||
      body.app !== "nomoreide" ||
      typeof body.version !== "string" ||
      typeof body.pid !== "number"
    ) {
      throw new Error("GET /api/health returned an unexpected response.");
    }
    const reachedAt = now();
    const recovered = snapshot.consecutiveFailures >= 2;
    emit({
      ...snapshot,
      phase: "connected",
      consecutiveFailures: 0,
      lastReachableAt: reachedAt,
      daemonVersion: body.version,
      daemonPid: body.pid,
      lastRecoveryAttempts: recovered
        ? snapshot.consecutiveFailures
        : snapshot.lastRecoveryAttempts,
      recoveredAt: recovered ? reachedAt : snapshot.recoveredAt,
    });
    return true;
  } catch (caught) {
    const failedAt = now();
    const consecutiveFailures = snapshot.consecutiveFailures + 1;
    emit({
      ...snapshot,
      phase: consecutiveFailures >= 2 ? "unreachable" : "reconnecting",
      consecutiveFailures,
      lastFailureAt: failedAt,
      lastFailedEndpoint: "GET /api/health",
      lastError: safeErrorMessage(caught),
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function diagnosticsTime(value: number | null): string {
  return value === null ? "Never" : new Date(value).toISOString();
}

export function formatRuntimeDiagnostics(
  current: RuntimeConnectionSnapshot,
  options: {
    apiTarget: string;
    browserOnline: boolean;
    frontendVersion: string;
  },
): string {
  return [
    "NoMoreIDE runtime diagnostics",
    `Connection: ${current.phase}`,
    `API target: ${options.apiTarget}`,
    `Browser online: ${options.browserOnline ? "yes" : "no"}`,
    `Frontend version: ${options.frontendVersion}`,
    `Daemon version: ${current.daemonVersion ?? "Unknown"}`,
    `Daemon PID: ${current.daemonPid ?? "Unknown"}`,
    `Reconnect attempts: ${
      current.consecutiveFailures || current.lastRecoveryAttempts
    }`,
    `Last reachable: ${diagnosticsTime(current.lastReachableAt)}`,
    `Last failure: ${diagnosticsTime(current.lastFailureAt)}`,
    `Failed endpoint: ${current.lastFailedEndpoint ?? "None"}`,
    `Browser error: ${current.lastError ?? "None"}`,
  ].join("\n");
}

/** Test isolation for the module-level external store. */
export function resetRuntimeConnectionForTests(): void {
  snapshot = INITIAL_SNAPSHOT;
  listeners.clear();
}
