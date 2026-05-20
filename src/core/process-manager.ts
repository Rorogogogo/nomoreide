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
import { createSshCommand } from "./ssh-service-runner.js";
import type { TimelineStore } from "./timeline-store.js";
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

  constructor(options: ProcessManagerOptions) {
    this.configStore = options.configStore;
    this.logStore = options.logStore;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3000;
    this.timelineStore = options.timelineStore;
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

    const child = spawnService(name, service, kind);

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
    void this.appendTimeline({
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
      void this.stopInspector(runtime);
      void this.appendTimeline({
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
      void this.logStore.append(name, "stderr", error.message);
      void this.appendTimeline({
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
      const stopped = { name, state: "stopped" as const };
      this.runtimes.set(name, { status: stopped, stopping: false });
      void this.appendTimeline({
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
    void this.appendTimeline({
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
    if (!runtime || !runtime.inspectorEnabled || runtime.inspectorHandle) return;
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
    void this.appendTimeline({
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
    void this.appendTimeline({
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
    const statuses: ServiceStatus[] = [];

    for (const serviceName of bundle.services) {
      statuses.push(await this.startService(serviceName));
    }

    return statuses;
  }

  async stopBundle(name: string): Promise<ServiceStatus[]> {
    const bundle = await this.getBundle(name);
    const statuses: ServiceStatus[] = [];

    for (const serviceName of bundle.services.slice().reverse()) {
      statuses.push(await this.stopService(serviceName));
    }

    return statuses;
  }

  async restartBundle(name: string): Promise<ServiceStatus[]> {
    await this.stopBundle(name);
    return this.startBundle(name);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.runtimes.keys()].map((name) => this.stopService(name)),
    );
  }

  killAllSync(signal: NodeJS.Signals = "SIGTERM"): void {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.child || runtime.child.exitCode !== null) continue;
      signalProcessTree(runtime.child, signal);
    }
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
    return {
      services: Object.fromEntries(
        [...this.runtimes.entries()].map(([name, runtime]) => [
          name,
          { ...runtime.status },
        ]),
      ),
    };
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

    return { services };
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
    void this.appendTimeline({
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

    void this.appendTimeline({
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
              void this.maybeStartInspector(service);
            }
            void this.appendTimeline({
              kind: "service.port",
              service,
              severity: "info",
              title: `${service} reported ${url}`,
              detail: url,
            });
          }
          void this.logStore.append(service, stream, line);
        }
      }
    });

    readable.on("end", () => {
      if (buffer.length > 0) {
        void this.logStore.append(service, stream, buffer);
        buffer = "";
      }
    });
  }

  private async appendTimeline(
    event: Parameters<TimelineStore["append"]>[0],
  ): Promise<void> {
    if (!this.timelineStore) return;
    await this.timelineStore.append(event);
  }
}

function resolveKind(service: ServiceDefinition): ServiceKind {
  return service.kind ?? "local";
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

function spawnService(
  name: string,
  service: ServiceDefinition,
  kind: ServiceKind,
): ChildProcess {
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
  return spawn(service.command, {
    cwd: service.cwd,
    env: { ...process.env, ...service.env },
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
