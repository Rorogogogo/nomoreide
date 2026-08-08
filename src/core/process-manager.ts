import { spawn, type ChildProcess } from "node:child_process";
import type { ConfigStore } from "./config-store.js";
import {
  readDockerServiceLogs,
  readDockerServiceStatus,
  startDockerService,
  stopDockerService,
  type DockerComposeTarget,
} from "./docker-service-runner.js";
import type { LogStore } from "./log-store.js";
import {
  startHttpInspector,
  type HttpInspectorEvent,
  type HttpInspectorHandle,
} from "./http-inspector.js";
import { getPortHolder, isPortAvailable, type PortHolder } from "./port-utils.js";
import { readProcessTree } from "./process-tree.js";
import { resolveStartOrder } from "./service-graph.js";
import {
  isPidAlive,
  type ServiceRegistry,
  type ServiceRegistryEntry,
} from "./service-registry.js";
import { createSshCommand } from "./ssh-service-runner.js";
import type { TimelineStore } from "./timeline-store.js";
import { entriesFromLines, envFilePath, readEnvFile } from "./env-file.js";
import type {
  BundleDefinition,
  ServiceDefinition,
  ServiceKind,
  ServiceStatus,
} from "./types.js";

interface ProcessManagerOptions {
  configStore: ConfigStore;
  logStore: LogStore;
  stopTimeoutMs?: number;
  timelineStore?: TimelineStore;
  /**
   * Shared cross-session view of running services. When provided, the manager
   * adopts services started by other sessions instead of spawning duplicates,
   * and can stop services it did not spawn itself. Omit for an isolated manager
   * (e.g. in tests) — behavior is then identical to a single-session manager.
   */
  registry?: ServiceRegistry;
}

interface RuntimeService {
  child?: ChildProcess;
  status: ServiceStatus;
  stopping: boolean;
  inspectorEnabled?: boolean;
  inspectorHandle?: HttpInspectorHandle;
}

export interface NoMoreIdeStatus {
  services: Record<string, ServiceStatus>;
}

export interface StartServiceOptions {
  killHolder?: boolean;
}

export class PortConflictError extends Error {
  readonly code = "PORT_IN_USE";
  readonly service: string;
  readonly port: number;
  readonly holder: PortHolder | null;

  constructor(service: string, port: number, holder: PortHolder | null) {
    const owner = holder ? ` (held by pid ${holder.pid} — ${holder.command})` : "";
    super(`Port ${port} is already in use for ${service}${owner}.`);
    this.name = "PortConflictError";
    this.service = service;
    this.port = port;
    this.holder = holder;
  }
}

export class ProcessManager {
  private readonly runtimes = new Map<string, RuntimeService>();
  private readonly configStore: ConfigStore;
  private readonly logStore: LogStore;
  private readonly stopTimeoutMs: number;
  private readonly timelineStore?: TimelineStore;
  private readonly registry?: ServiceRegistry;
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(options: ProcessManagerOptions) {
    this.configStore = options.configStore;
    this.logStore = options.logStore;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3000;
    this.timelineStore = options.timelineStore;
    this.registry = options.registry;
  }

  async startService(
    name: string,
    options: StartServiceOptions = {},
  ): Promise<ServiceStatus> {
    const service = await this.getService(name);
    const existing = this.runtimes.get(name);

    if (existing?.status.state === "running") {
      return { ...existing.status };
    }

    const kind = resolveKind(service);

    if (kind === "docker-compose") {
      return this.startDockerComposeService(name, service);
    }

    // Another session may already be running this exact service. Adopt its
    // status instead of spawning a duplicate — this also covers portless
    // services, where the port check below cannot detect the conflict.
    const tracked = this.registry?.get(name);
    if (tracked) {
      return registryEntryToStatus(tracked);
    }

    if (service.port && !(await isPortAvailable(service.port))) {
      const holder = await getPortHolder(service.port);
      if (options.killHolder && holder) {
        await killHolder(holder);
        if (!(await waitForPortFree(service.port, 3000))) {
          throw new PortConflictError(name, service.port, holder);
        }
      } else {
        throw new PortConflictError(name, service.port, holder);
      }
    }

    const child = await spawnService(name, service, kind);

    const runtime: RuntimeService = {
      child,
      stopping: false,
      status: {
        name,
        state: "running",
        kind,
        host: kind === "ssh" ? service.host : undefined,
        pid: child.pid,
        startedAt: new Date().toISOString(),
      },
    };

    this.runtimes.set(name, runtime);
    if (child.pid) {
      this.registry?.record({
        name,
        pid: child.pid,
        pgid: child.pid, // detached spawn → child.pid is the process-group leader
        port: service.port,
        kind,
        host: kind === "ssh" ? service.host : undefined,
        startedAt: runtime.status.startedAt ?? new Date().toISOString(),
        ownerPid: process.pid,
      });
    }
    this.appendTimeline({
      kind: "service.lifecycle",
      service: name,
      severity: "info",
      title: `${name} started`,
      data: {
        pid: child.pid,
      },
    });
    this.captureStream(name, "stdout", child.stdout);
    this.captureStream(name, "stderr", child.stderr);

    child.once("exit", (exitCode, signal) => {
      const nextState = runtime.stopping ? "stopped" : "exited";
      runtime.status = {
        ...runtime.status,
        state: nextState,
        exitedAt: new Date().toISOString(),
        exitCode,
        signal,
      };
      runtime.child = undefined;
      this.registry?.remove(name);
      void this.stopInspector(runtime);
      this.appendTimeline({
        kind: "service.lifecycle",
        service: name,
        severity: nextState === "exited" && exitCode ? "error" : "info",
        title: `${name} ${nextState}`,
        data: {
          exitCode,
          signal,
        },
      });
    });

    child.once("error", (error) => {
      runtime.status = {
        ...runtime.status,
        state: "exited",
        exitedAt: new Date().toISOString(),
        exitCode: 1,
        signal: null,
      };
      this.registry?.remove(name);
      this.trackWrite(this.logStore.append(name, "stderr", error.message));
      this.appendTimeline({
        kind: "service.lifecycle",
        service: name,
        severity: "error",
        title: `${name} failed`,
        detail: error.message,
      });
    });

    return { ...runtime.status };
  }

  async stopService(name: string): Promise<ServiceStatus> {
    const runtime = this.runtimes.get(name);

    if (runtime?.status.kind === "docker-compose" && runtime.status.state === "running") {
      return this.stopDockerComposeService(name, runtime);
    }

    if (!runtime?.child || runtime.status.state !== "running") {
      // No live child in this session — a sibling session may own it. If the
      // registry has a live entry, signal its process group to stop it.
      const tracked = this.registry?.get(name);
      if (tracked) {
        await stopByPid(tracked.pid, tracked.pgid, this.stopTimeoutMs);
        this.registry?.remove(name);
      }
      const stopped = { name, state: "stopped" as const };
      this.runtimes.set(name, { status: stopped, stopping: false });
      this.appendTimeline({
        kind: "service.lifecycle",
        service: name,
        severity: "info",
        title: `${name} stopped`,
      });
      return stopped;
    }

    runtime.stopping = true;
    await stopChild(runtime.child, this.stopTimeoutMs);

    const stopped: ServiceStatus = {
      ...runtime.status,
      state: "stopped",
      exitedAt: runtime.status.exitedAt ?? new Date().toISOString(),
    };
    runtime.status = stopped;
    runtime.child = undefined;
    this.appendTimeline({
      kind: "service.lifecycle",
      service: name,
      severity: "info",
      title: `${name} stopped`,
    });

    return { ...stopped };
  }

  async restartService(
    name: string,
    options: StartServiceOptions = {},
  ): Promise<ServiceStatus> {
    await this.stopService(name);
    return this.startService(name, options);
  }

  async setInspectorEnabled(name: string, enabled: boolean): Promise<ServiceStatus> {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new Error(`Service "${name}" is not running.`);
    }
    runtime.inspectorEnabled = enabled;
    if (enabled) {
      await this.maybeStartInspector(name);
    } else {
      await this.stopInspector(runtime);
    }
    runtime.status = {
      ...runtime.status,
      inspector: this.inspectorStatus(runtime),
    };
    return { ...runtime.status };
  }

  private async maybeStartInspector(name: string): Promise<void> {
    const runtime = this.runtimes.get(name);
    if (!runtime?.inspectorEnabled || runtime.inspectorHandle) return;
    const upstreamPort = portFromUrl(runtime.status.url);
    if (!upstreamPort) return;
    const handle = await startHttpInspector({
      upstreamPort,
      onEvent: (event) => this.recordInspectorEvent(name, event),
    });
    runtime.inspectorHandle = handle;
    runtime.status = {
      ...runtime.status,
      inspector: { enabled: true, port: handle.port, upstreamPort },
    };
    this.appendTimeline({
      kind: "service.lifecycle",
      service: name,
      severity: "info",
      title: `${name} HTTP inspector on :${handle.port}`,
      detail: `Proxying to upstream :${upstreamPort}`,
    });
  }

  private async stopInspector(runtime: RuntimeService): Promise<void> {
    if (!runtime.inspectorHandle) return;
    const handle = runtime.inspectorHandle;
    runtime.inspectorHandle = undefined;
    await handle.stop();
  }

  private inspectorStatus(runtime: RuntimeService) {
    if (!runtime.inspectorEnabled) return undefined;
    return {
      enabled: true,
      port: runtime.inspectorHandle?.port,
      upstreamPort: portFromUrl(runtime.status.url),
    };
  }

  private recordInspectorEvent(name: string, event: HttpInspectorEvent): void {
    const severity: "info" | "warning" | "error" =
      event.status >= 500 ? "error" : event.status >= 400 ? "warning" : "info";
    this.appendTimeline({
      kind: "service.http",
      service: name,
      severity,
      title: `${event.method} ${event.path} → ${event.status}`,
      detail: `${event.durationMs} ms`,
      timestamp: event.startedAt,
      data: {
        id: event.id,
        method: event.method,
        path: event.path,
        status: event.status,
        durationMs: event.durationMs,
        reqBytes: event.reqBytes,
        resBytes: event.resBytes,
      },
    });
  }

  async startBundle(name: string): Promise<ServiceStatus[]> {
    const bundle = await this.getBundle(name);
    const config = await this.configStore.load();
    // Topologically order the bundle (and any transitive deps it declares) so
    // dependencies come up before dependents. Throws DependencyCycleError on a
    // cycle, surfacing a clear message instead of a half-started bundle.
    const order = resolveStartOrder(config.services, bundle.services);
    const byName = new Map(config.services.map((service) => [service.name, service]));
    const statuses: ServiceStatus[] = [];

    for (const serviceName of order) {
      // Each declared dependency precedes this service in `order` and is thus
      // already started; wait for it to report ready before the dependent.
      for (const dep of byName.get(serviceName)?.dependsOn ?? []) {
        if (byName.has(dep)) await this.waitForServiceReady(dep);
      }
      statuses.push(await this.startService(serviceName));
    }

    return statuses;
  }

  async stopBundle(name: string): Promise<ServiceStatus[]> {
    const bundle = await this.getBundle(name);
    const order = await this.safeStopOrder(bundle);
    const statuses: ServiceStatus[] = [];

    // Reverse dependency order: stop dependents before the services they need.
    for (const serviceName of order.reverse()) {
      statuses.push(await this.stopService(serviceName));
    }

    return statuses;
  }

  /**
   * Stop order scoped to the bundle's own members, in dependency order so we
   * can reverse it. Falls back to declaration order if a cycle makes a topo
   * sort impossible — stopping must never throw the way a start can.
   */
  private async safeStopOrder(bundle: BundleDefinition): Promise<string[]> {
    try {
      const config = await this.configStore.load();
      const resolved = resolveStartOrder(config.services, bundle.services);
      const inBundle = new Set(bundle.services);
      return resolved.filter((serviceName) => inBundle.has(serviceName));
    } catch {
      return bundle.services.slice();
    }
  }

  /**
   * Wait until a dependency looks ready before starting services that depend on
   * it. A service with a port is "ready" once that port is bound; portless
   * services have no probe, so we return immediately. Times out (warning, not
   * error) so a slow/never-binding dependency can't wedge a bundle start.
   */
  private async waitForServiceReady(name: string, timeoutMs = 15000): Promise<void> {
    const service = await this.getService(name).catch(() => undefined);
    if (!service?.port) return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.runtimes.get(name)?.status.state === "exited") return;
      if (!(await isPortAvailable(service.port))) return; // port bound → ready
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    this.appendTimeline({
      kind: "service.health",
      service: name,
      severity: "warning",
      title: `${name} did not become ready in ${Math.round(timeoutMs / 1000)}s`,
      detail: `Port ${service.port} never came up; starting dependents anyway.`,
    });
  }

  async restartBundle(name: string): Promise<ServiceStatus[]> {
    await this.stopBundle(name);
    return this.startBundle(name);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.runtimes.keys()].map((name) => this.stopService(name)),
    );
    await this.flushWrites();
  }

  /**
   * Resolves once every log/timeline write started so far has settled. Exit
   * handlers append after the child is gone, so without this a caller that
   * tears down the log directory right after `stopAll()` races those writes.
   */
  async flushWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.all([...this.pendingWrites]);
    }
  }

  killAllSync(signal: NodeJS.Signals = "SIGTERM"): void {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.child || runtime.child.exitCode !== null) continue;
      signalProcessTree(runtime.child, signal);
    }
    // Drop this session's entries synchronously; the async exit handlers above
    // may not run before the host process exits.
    this.registry?.removeOwnedBy(process.pid);
  }

  installShutdownHandlers(): () => void {
    let firing = false;
    const handle = (signal: NodeJS.Signals) => () => {
      if (firing) return;
      firing = true;
      this.killAllSync("SIGTERM");
      // Re-raise the signal with default behavior so the host exits.
      setTimeout(() => process.kill(process.pid, signal), 50);
    };
    const onExit = () => this.killAllSync("SIGTERM");
    const sigint = handle("SIGINT");
    const sigterm = handle("SIGTERM");
    const sighup = handle("SIGHUP");
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
    process.once("SIGHUP", sighup);
    process.once("exit", onExit);
    return () => {
      process.removeListener("SIGINT", sigint);
      process.removeListener("SIGTERM", sigterm);
      process.removeListener("SIGHUP", sighup);
      process.removeListener("exit", onExit);
    };
  }

  status(): NoMoreIdeStatus {
    const services: Record<string, ServiceStatus> = {};
    for (const [name, runtime] of this.runtimes.entries()) {
      services[name] = { ...runtime.status };
    }
    this.mergeRegistry(services);
    return { services };
  }

  async statusWithResources(): Promise<NoMoreIdeStatus> {
    const services: Record<string, ServiceStatus> = {};

    for (const [name, runtime] of this.runtimes.entries()) {
      const status: ServiceStatus = { ...runtime.status };
      if (status.pid && status.state === "running") {
        status.processTree = await readProcessTree(status.pid);
      }
      status.inspector = this.inspectorStatus(runtime);
      services[name] = status;
    }

    this.mergeRegistry(services);
    for (const status of Object.values(services)) {
      if (status.pid && status.state === "running" && !status.processTree) {
        status.processTree = await readProcessTree(status.pid);
      }
    }

    return { services };
  }

  /**
   * Fold in services started by sibling sessions. A registry entry wins only
   * when this session has no running view of that service, so a locally-owned
   * "running" status is never overwritten by the shared snapshot.
   */
  private mergeRegistry(services: Record<string, ServiceStatus>): void {
    if (!this.registry) return;
    for (const entry of this.registry.list()) {
      const local = services[entry.name];
      if (!local || local.state !== "running") {
        services[entry.name] = registryEntryToStatus(entry);
      }
    }
  }

  private async startDockerComposeService(
    name: string,
    service: ServiceDefinition,
  ): Promise<ServiceStatus> {
    const target = toDockerTarget(name, service);
    const info = await startDockerService(target);

    const status: ServiceStatus = {
      name,
      state: "running",
      kind: "docker-compose",
      startedAt: new Date().toISOString(),
      containerId: info.containerId,
    };

    this.runtimes.set(name, { status, stopping: false });
    this.appendTimeline({
      kind: "service.lifecycle",
      service: name,
      severity: "info",
      title: `${name} started`,
      data: { containerId: info.containerId },
    });

    return { ...status };
  }

  private async stopDockerComposeService(
    name: string,
    runtime: RuntimeService,
  ): Promise<ServiceStatus> {
    const service = await this.getService(name);
    runtime.stopping = true;
    await stopDockerService(toDockerTarget(name, service));

    const stopped: ServiceStatus = {
      ...runtime.status,
      state: "stopped",
      exitedAt: new Date().toISOString(),
    };
    runtime.status = stopped;

    this.appendTimeline({
      kind: "service.lifecycle",
      service: name,
      severity: "info",
      title: `${name} stopped`,
    });

    return { ...stopped };
  }

  async readDockerServiceLogs(name: string, tail = 120): Promise<string> {
    const service = await this.getService(name);
    if (resolveKind(service) !== "docker-compose") {
      throw new Error(`Service "${name}" is not a docker-compose service.`);
    }
    return readDockerServiceLogs(toDockerTarget(name, service), tail);
  }

  async readDockerServiceStatus(name: string) {
    const service = await this.getService(name);
    if (resolveKind(service) !== "docker-compose") {
      throw new Error(`Service "${name}" is not a docker-compose service.`);
    }
    return readDockerServiceStatus(toDockerTarget(name, service));
  }

  private async getService(name: string): Promise<ServiceDefinition> {
    const config = await this.configStore.load();
    const service = config.services.find((item) => item.name === name);

    if (!service) {
      throw new Error(`Service "${name}" is not registered.`);
    }

    return service;
  }

  private async getBundle(name: string): Promise<BundleDefinition> {
    const config = await this.configStore.load();
    const bundle = config.bundles.find((item) => item.name === name);

    if (!bundle) {
      throw new Error(`Bundle "${name}" is not registered.`);
    }

    return bundle;
  }

  private captureStream(
    service: string,
    stream: "stdout" | "stderr",
    readable: NodeJS.ReadableStream | null,
  ): void {
    if (!readable) {
      return;
    }

    let buffer = "";
    readable.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.length > 0) {
          const url = localUrlFromLine(line);
          if (url) {
            const runtime = this.runtimes.get(service);
            if (runtime) {
              runtime.status = { ...runtime.status, url };
              this.registry?.update(service, { url });
              void this.maybeStartInspector(service);
            }
            this.appendTimeline({
              kind: "service.port",
              service,
              severity: "info",
              title: `${service} reported ${url}`,
              detail: url,
            });
          }
          this.trackWrite(this.logStore.append(service, stream, line));
        }
      }
    });

    readable.on("end", () => {
      if (buffer.length > 0) {
        this.trackWrite(this.logStore.append(service, stream, buffer));
        buffer = "";
      }
    });
  }

  private appendTimeline(event: Parameters<TimelineStore["append"]>[0]): void {
    if (!this.timelineStore) return;
    this.trackWrite(this.timelineStore.append(event));
  }

  /**
   * Register a fire-and-forget log/timeline write so `flushWrites()` can wait
   * for it. These are telemetry about an operation, not the operation itself,
   * so a failed write is dropped rather than escalated into an unhandled
   * rejection that would take down the daemon (or fail an unrelated test).
   */
  private trackWrite(write: Promise<unknown>): void {
    const pending = write.then(
      () => undefined,
      () => undefined,
    );
    this.pendingWrites.add(pending);
    void pending.then(() => this.pendingWrites.delete(pending));
  }
}

function resolveKind(service: ServiceDefinition): ServiceKind {
  return service.kind ?? "local";
}

function registryEntryToStatus(entry: ServiceRegistryEntry): ServiceStatus {
  return {
    name: entry.name,
    state: "running",
    kind: entry.kind,
    pid: entry.pid,
    url: entry.url,
    host: entry.host,
    startedAt: entry.startedAt,
  };
}

/**
 * Stop a process by pid when we hold no ChildProcess handle for it (it was
 * spawned by another session). Signals the whole process group, then escalates
 * to SIGKILL if it has not exited within the timeout.
 */
async function stopByPid(
  pid: number,
  pgid: number | undefined,
  timeoutMs: number,
): Promise<void> {
  signalPid(pid, pgid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  signalPid(pid, pgid, "SIGKILL");
}

function signalPid(
  pid: number,
  pgid: number | undefined,
  signal: NodeJS.Signals,
): void {
  const group = pgid ?? pid;
  try {
    // Negative pid signals the whole process group (detached spawn → pgid===pid).
    process.kill(-group, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  }
}

function toDockerTarget(
  name: string,
  service: ServiceDefinition,
): DockerComposeTarget {
  if (!service.cwd || !service.composeService) {
    throw new Error(
      `Service "${name}" is missing docker-compose cwd or composeService.`,
    );
  }
  return {
    cwd: service.cwd,
    composeFile: service.composeFile,
    composeService: service.composeService,
  };
}

async function spawnService(
  name: string,
  service: ServiceDefinition,
  kind: ServiceKind,
): Promise<ChildProcess> {
  if (kind === "ssh") {
    if (!service.host || !service.cwd || !service.command) {
      throw new Error(
        `Service "${name}" is missing ssh host, cwd, or command.`,
      );
    }
    const [bin, args] = createSshCommand({
      host: service.host,
      cwd: service.cwd,
      command: service.command,
      env: service.env,
    });
    return spawn(bin, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  }
  if (!service.command || !service.cwd) {
    throw new Error(`Service "${name}" is missing command or cwd.`);
  }
  const envFile = await readEnvFile(envFilePath(service.cwd));
  const fileEnv = envFile.exists
    ? Object.fromEntries(entriesFromLines(envFile.lines).map((entry) => [entry.key, entry.value]))
    : {};

  return spawn(service.command, {
    cwd: service.cwd,
    // Load the conventional .env next to the service, while allowing values
    // configured explicitly in NoMoreIDE to override it.
    env: { ...process.env, ...fileEnv, ...service.env },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

function localUrlFromLine(line: string): string | undefined {
  return line.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/)?.[0];
}

function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = url.match(/:(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function stopChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      signalProcessTree(child, "SIGKILL");
      finish();
    }, timeoutMs);

    child.once("exit", finish);
    signalProcessTree(child, "SIGTERM");
  });
}

async function killHolder(holder: PortHolder): Promise<void> {
  const target = holder.pgid ? -holder.pgid : holder.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
  // Give the process a moment to exit cleanly before escalating.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(holder.pid, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // ignore
  }
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return isPortAvailable(port);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    // Negative PID = signal the whole process group whose leader is `pid`.
    // The service was spawned with detached: true so child.pid === PGID.
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    // Fall back to signaling the direct child if the group is gone.
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}
