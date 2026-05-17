import { spawn, type ChildProcess } from "node:child_process";
import type { ConfigStore } from "./config-store.js";
import type { LogStore } from "./log-store.js";
import { isPortAvailable } from "./port-utils.js";
import type {
  BundleDefinition,
  ServiceDefinition,
  ServiceStatus,
} from "./types.js";

interface ProcessManagerOptions {
  configStore: ConfigStore;
  logStore: LogStore;
  stopTimeoutMs?: number;
}

interface RuntimeService {
  child?: ChildProcess;
  status: ServiceStatus;
  stopping: boolean;
}

export interface NoMoreIdeStatus {
  services: Record<string, ServiceStatus>;
}

export class ProcessManager {
  private readonly runtimes = new Map<string, RuntimeService>();
  private readonly configStore: ConfigStore;
  private readonly logStore: LogStore;
  private readonly stopTimeoutMs: number;

  constructor(options: ProcessManagerOptions) {
    this.configStore = options.configStore;
    this.logStore = options.logStore;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3000;
  }

  async startService(name: string): Promise<ServiceStatus> {
    const service = await this.getService(name);
    const existing = this.runtimes.get(name);

    if (existing?.status.state === "running") {
      return { ...existing.status };
    }

    if (service.port && !(await isPortAvailable(service.port))) {
      throw new Error(`Port ${service.port} is already in use for ${name}.`);
    }

    const child = spawn(service.command, {
      cwd: service.cwd,
      env: { ...process.env, ...service.env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const runtime: RuntimeService = {
      child,
      stopping: false,
      status: {
        name,
        state: "running",
        pid: child.pid,
        startedAt: new Date().toISOString(),
      },
    };

    this.runtimes.set(name, runtime);
    this.captureStream(name, "stdout", child.stdout);
    this.captureStream(name, "stderr", child.stderr);

    child.once("exit", (exitCode, signal) => {
      runtime.status = {
        ...runtime.status,
        state: runtime.stopping ? "stopped" : "exited",
        exitedAt: new Date().toISOString(),
        exitCode,
        signal,
      };
      runtime.child = undefined;
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
    });

    return { ...runtime.status };
  }

  async stopService(name: string): Promise<ServiceStatus> {
    const runtime = this.runtimes.get(name);

    if (!runtime?.child || runtime.status.state !== "running") {
      const stopped = { name, state: "stopped" as const };
      this.runtimes.set(name, { status: stopped, stopping: false });
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

    return { ...stopped };
  }

  async restartService(name: string): Promise<ServiceStatus> {
    await this.stopService(name);
    return this.startService(name);
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
            }
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
}

function localUrlFromLine(line: string): string | undefined {
  return line.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/)?.[0];
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
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);

    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}
