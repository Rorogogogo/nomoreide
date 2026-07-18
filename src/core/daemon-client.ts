import type { NoMoreIdeStatus } from "./process-manager.js";
import type { PortHolder } from "./port-utils.js";
import type {
  LogEntry,
  NoMoreIdeConfig,
  ServiceStatus,
  TimelineEvent,
} from "./types.js";
import {
  defaultDaemonStatePath,
  ensureDaemon,
  probeDaemon,
  readDaemonState,
  resolveDaemonPort,
  type DaemonLifecycleOptions,
  type EnsureDaemonResult,
} from "./daemon-lifecycle.js";

/** Non-2xx daemon response that isn't a port conflict. */
export class DaemonRequestError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "DaemonRequestError";
  }
}

/** Mirrors the daemon's serialized PortConflictError (HTTP 409 + conflict body). */
export class DaemonPortConflictError extends Error {
  readonly code = "PORT_IN_USE";

  constructor(
    message: string,
    readonly port: number,
    readonly holder: PortHolder | null,
  ) {
    super(message);
    this.name = "DaemonPortConflictError";
  }
}

export interface StartOptions {
  killHolder?: boolean;
}

/** Subset of the `/api/dashboard` payload the clients consume. */
export interface DaemonDashboard {
  ok: boolean;
  config: NoMoreIdeConfig;
  runtime: NoMoreIdeStatus;
  health: unknown;
  timeline: TimelineEvent[];
}

export interface DaemonClientOptions {
  fetch?: typeof fetch;
}

/**
 * Typed fetch client for the daemon's existing HTTP API. Thin by design:
 * every method maps 1:1 onto a route the web UI already uses.
 */
export class DaemonClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    readonly url: string,
    options: DaemonClientOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
  }

  async status(): Promise<NoMoreIdeStatus> {
    const body = await this.request<{ status: NoMoreIdeStatus }>(
      "GET",
      "/api/status",
    );
    return body.status;
  }

  async dashboard(): Promise<DaemonDashboard> {
    return await this.request<DaemonDashboard>("GET", "/api/dashboard");
  }

  async logs(name: string, lines = 200): Promise<LogEntry[]> {
    const body = await this.request<{ logs: LogEntry[] }>(
      "GET",
      `/api/services/${encodeURIComponent(name)}/logs?lines=${lines}`,
    );
    return body.logs;
  }

  async timeline(limit = 120): Promise<TimelineEvent[]> {
    const body = await this.request<{ timeline: TimelineEvent[] }>(
      "GET",
      `/api/timeline?limit=${limit}`,
    );
    return body.timeline;
  }

  async startService(name: string, options: StartOptions = {}): Promise<ServiceStatus> {
    return await this.serviceAction(name, "start", options);
  }

  async stopService(name: string): Promise<ServiceStatus> {
    return await this.serviceAction(name, "stop");
  }

  async restartService(name: string, options: StartOptions = {}): Promise<ServiceStatus> {
    return await this.serviceAction(name, "restart", options);
  }

  async startBundle(name: string): Promise<ServiceStatus[]> {
    return await this.bundleAction(name, "start");
  }

  async stopBundle(name: string): Promise<ServiceStatus[]> {
    return await this.bundleAction(name, "stop");
  }

  async restartBundle(name: string): Promise<ServiceStatus[]> {
    return await this.bundleAction(name, "restart");
  }

  /** Asks the daemon to stop every service and exit. */
  async shutdown(): Promise<void> {
    await this.request<{ ok: boolean }>("POST", "/api/daemon/shutdown");
  }

  private async serviceAction(
    name: string,
    action: "start" | "stop" | "restart",
    options: StartOptions = {},
  ): Promise<ServiceStatus> {
    const form = new URLSearchParams();
    if (options.killHolder) form.set("strategy", "killHolder");
    const body = await this.request<{ status: ServiceStatus }>(
      "POST",
      `/api/services/${encodeURIComponent(name)}/${action}`,
      form,
    );
    return body.status;
  }

  private async bundleAction(
    name: string,
    action: "start" | "stop" | "restart",
  ): Promise<ServiceStatus[]> {
    const body = await this.request<{ statuses: ServiceStatus[] }>(
      "POST",
      `/api/bundles/${encodeURIComponent(name)}/${action}`,
    );
    return body.statuses;
  }

  private async request<T extends object>(
    method: "GET" | "POST",
    path: string,
    form?: URLSearchParams,
  ): Promise<T> {
    const response = await this.fetchFn(new URL(path, this.url), {
      method,
      ...(form
        ? {
            body: form.toString(),
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }
        : {}),
    });
    const body = (await response.json().catch(() => ({}))) as T & {
      ok?: boolean;
      error?: string;
      conflict?: { code?: string; port?: number; holder?: PortHolder | null };
    };
    if (!response.ok || body.ok === false) {
      const message = body.error ?? `Daemon request failed (${response.status})`;
      if (body.conflict?.code === "PORT_IN_USE") {
        throw new DaemonPortConflictError(
          message,
          body.conflict.port ?? 0,
          body.conflict.holder ?? null,
        );
      }
      throw new DaemonRequestError(message, response.status);
    }
    return body;
  }
}

/**
 * Lazy daemon handle shared by MCP/CLI/TUI: every `client()` call re-runs
 * `ensureDaemon` (one local health round-trip on the happy path), so a daemon
 * that died mid-session is respawned instead of surfacing connection errors.
 */
export interface DaemonConnection {
  ensure(): Promise<EnsureDaemonResult>;
  client(): Promise<DaemonClient>;
  /** A client for an already-running daemon, or null — never spawns one. */
  existing(): Promise<DaemonClient | null>;
}

export function createDaemonConnection(
  options: DaemonLifecycleOptions = {},
): DaemonConnection {
  return {
    ensure: () => ensureDaemon(options),
    async client(): Promise<DaemonClient> {
      const ensured = await ensureDaemon(options);
      return new DaemonClient(ensured.url, { fetch: options.fetch });
    },
    async existing(): Promise<DaemonClient | null> {
      const state = await readDaemonState(
        options.statePath ?? defaultDaemonStatePath(),
      );
      const url =
        state?.url ??
        `http://127.0.0.1:${options.port ?? resolveDaemonPort(options.env)}`;
      const probe = await probeDaemon(url, options.fetch);
      if (probe.kind !== "nomoreide") return null;
      return new DaemonClient(url, { fetch: options.fetch });
    },
  };
}
