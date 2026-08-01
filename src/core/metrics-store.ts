import type { ProcessManager } from "./process-manager.js";
import {
  findStatsFor,
  indexStatsById,
  listDockerStats,
  parseDockerMemoryUsageMb,
  type DockerContainerStats,
} from "./docker-stats.js";
import {
  HostMetricsCollector,
  type HostMetricSample,
} from "./host-metrics.js";
import {
  readProcessTree,
  type ProcessTreeSummary,
} from "./process-tree.js";
import {
  classifySystemProcesses,
  readSystemProcesses,
  type SystemProcess,
} from "./system-processes.js";

export interface MetricSample {
  t: number;
  cpu: number;
  rss: number;
}

export interface MetricsSeries {
  service: string;
  startedAt?: string;
  sampleIntervalMs: number;
  samples: MetricSample[];
}

interface ServiceBuffer {
  startedAt?: string;
  samples: MetricSample[];
  latest?: {
    sampledAt: number;
    cpuPercent: number;
    rssMb: number;
    processCount?: number;
    memoryPercent?: number;
    source: "local" | "docker";
  };
}

export interface ServiceActivityMetric {
  service: string;
  startedAt?: string;
  sampledAt: number;
  cpuPercent: number;
  rssMb: number;
  processCount?: number;
  memoryPercent?: number;
  source: "local" | "docker";
}

export interface ActivityMetrics {
  sampleIntervalMs: number;
  host: {
    current: HostMetricSample | null;
    samples: HostMetricSample[];
  };
  services: Record<string, ServiceActivityMetric>;
  systemProcesses: SystemProcess[];
}

export interface MetricsStoreOptions {
  manager: ProcessManager;
  /** Seconds between samples. */
  intervalMs?: number;
  /** Max samples kept per service (ring buffer). */
  capacity?: number;
  cwd?: string;
  hostCollector?: Pick<HostMetricsCollector, "sample">;
  processTreeReader?: (rootPid: number) => Promise<ProcessTreeSummary>;
  systemProcessReader?: () => Promise<SystemProcess[]>;
  dockerStatsReader?: () => Promise<DockerContainerStats[]>;
  now?: () => number;
}

/**
 * In-memory CPU/RSS time series for managed services. Polls process trees on a
 * fixed cadence; PIDs that disappear are kept in the buffer so the chart can
 * still render the last run. A subsequent start resets the series.
 */
export class MetricsStore {
  private readonly manager: ProcessManager;
  private readonly intervalMs: number;
  private readonly capacity: number;
  private readonly hostCollector: Pick<HostMetricsCollector, "sample">;
  private readonly processTreeReader: (rootPid: number) => Promise<ProcessTreeSummary>;
  private readonly systemProcessReader: () => Promise<SystemProcess[]>;
  private readonly dockerStatsReader: () => Promise<DockerContainerStats[]>;
  private readonly now: () => number;
  private readonly buffers = new Map<string, ServiceBuffer>();
  private readonly hostSamples: HostMetricSample[] = [];
  private systemProcesses: SystemProcess[] = [];
  private timer?: NodeJS.Timeout;
  private sampling = false;

  constructor(options: MetricsStoreOptions) {
    this.manager = options.manager;
    this.intervalMs = options.intervalMs ?? 3000;
    this.capacity = options.capacity ?? 600;
    this.hostCollector =
      options.hostCollector ?? new HostMetricsCollector(options.cwd ?? process.cwd());
    this.processTreeReader = options.processTreeReader ?? readProcessTree;
    this.systemProcessReader = options.systemProcessReader ?? readSystemProcesses;
    this.dockerStatsReader = options.dockerStatsReader ?? listDockerStats;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sampleOnce(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    void this.sampleOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  read(service: string): MetricsSeries {
    const buffer = this.buffers.get(service);
    return {
      service,
      startedAt: buffer?.startedAt,
      sampleIntervalMs: this.intervalMs,
      samples: buffer ? [...buffer.samples] : [],
    };
  }

  readActivity(): ActivityMetrics {
    const statuses = this.manager.status().services;
    const services: Record<string, ServiceActivityMetric> = {};
    const currentHostSample = this.hostSamples.at(-1);
    for (const [name, buffer] of this.buffers) {
      const status = statuses[name];
      if (
        status?.state !== "running" ||
        !buffer.latest ||
        buffer.startedAt !== status.startedAt
      ) {
        continue;
      }
      services[name] = {
        service: name,
        startedAt: buffer.startedAt,
        sampledAt: buffer.latest.sampledAt,
        cpuPercent: buffer.latest.cpuPercent,
        rssMb: buffer.latest.rssMb,
        processCount: buffer.latest.processCount,
        memoryPercent: buffer.latest.memoryPercent,
        source: buffer.latest.source,
      };
    }
    return {
      sampleIntervalMs: this.intervalMs,
      host: {
        current: currentHostSample ? cloneHostSample(currentHostSample) : null,
        samples: this.hostSamples.map(cloneHostSample),
      },
      services,
      systemProcesses: classifySystemProcesses(
        this.systemProcesses,
        Object.values(statuses)
          .filter((status) => status.state === "running" && status.pid)
          .map((status) => ({ pid: status.pid as number, service: status.name })),
      ),
    };
  }

  async sampleOnce(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const { services } = this.manager.status();
      const now = this.now();
      const hostSample = this.hostCollector.sample(now).catch(() => undefined);
      const systemProcesses = this.systemProcessReader().catch(() => undefined);
      const dockerServices = Object.values(services).filter(
        (status) =>
          status.state === "running" &&
          status.kind === "docker-compose" &&
          status.containerId,
      );
      const dockerStats =
        dockerServices.length > 0
          ? this.dockerStatsReader().catch(() => undefined)
          : Promise.resolve(undefined);
      await Promise.all(
        Object.values(services).map(async (status) => {
          if (
            status.state !== "running" ||
            !status.pid ||
            status.kind === "docker-compose" ||
            status.kind === "ssh"
          ) {
            return;
          }
          let buffer = this.buffers.get(status.name);
          // New run (or first sample) → reset the series so the chart starts at startedAt.
          if (!buffer || buffer.startedAt !== status.startedAt) {
            buffer = { startedAt: status.startedAt, samples: [] };
            this.buffers.set(status.name, buffer);
          }
          try {
            const tree = await this.processTreeReader(status.pid);
            buffer.samples.push({ t: now, cpu: tree.cpuPercent, rss: tree.rssMb });
            buffer.latest = {
              sampledAt: now,
              cpuPercent: tree.cpuPercent,
              rssMb: tree.rssMb,
              processCount: tree.processCount,
              source: "local",
            };
            if (buffer.samples.length > this.capacity) {
              buffer.samples.splice(0, buffer.samples.length - this.capacity);
            }
          } catch {
            // ps may briefly fail right after spawn / during exit — skip this tick.
          }
        }),
      );
      const nextDockerStats = await dockerStats;
      if (nextDockerStats) {
        const statsById = indexStatsById(nextDockerStats);
        for (const status of dockerServices) {
          const stats = findStatsFor(statsById, status.containerId as string);
          const rssMb = stats ? parseDockerMemoryUsageMb(stats.memoryUsage) : null;
          if (!stats || stats.cpuPercent === null || rssMb === null) continue;
          let buffer = this.buffers.get(status.name);
          if (!buffer || buffer.startedAt !== status.startedAt) {
            buffer = { startedAt: status.startedAt, samples: [] };
            this.buffers.set(status.name, buffer);
          }
          buffer.samples.push({ t: now, cpu: stats.cpuPercent, rss: rssMb });
          buffer.latest = {
            sampledAt: now,
            cpuPercent: stats.cpuPercent,
            rssMb,
            memoryPercent: stats.memoryPercent ?? undefined,
            source: "docker",
          };
          if (buffer.samples.length > this.capacity) {
            buffer.samples.splice(0, buffer.samples.length - this.capacity);
          }
        }
      }
      const nextHostSample = await hostSample;
      if (nextHostSample) {
        this.hostSamples.push(nextHostSample);
        if (this.hostSamples.length > this.capacity) {
          this.hostSamples.splice(0, this.hostSamples.length - this.capacity);
        }
      }
      const nextSystemProcesses = await systemProcesses;
      if (nextSystemProcesses) this.systemProcesses = nextSystemProcesses;
    } finally {
      this.sampling = false;
    }
  }
}

function cloneHostSample(sample: HostMetricSample): HostMetricSample {
  return {
    ...sample,
    loadAverage: sample.loadAverage ? [...sample.loadAverage] : null,
    disk: sample.disk ? { ...sample.disk } : null,
  };
}
