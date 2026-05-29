import type { ProcessManager } from "./process-manager.js";
import { readProcessTree } from "./process-tree.js";

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
}

export interface MetricsStoreOptions {
  manager: ProcessManager;
  /** Seconds between samples. */
  intervalMs?: number;
  /** Max samples kept per service (ring buffer). */
  capacity?: number;
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
  private readonly buffers = new Map<string, ServiceBuffer>();
  private timer?: NodeJS.Timeout;
  private sampling = false;

  constructor(options: MetricsStoreOptions) {
    this.manager = options.manager;
    this.intervalMs = options.intervalMs ?? 3000;
    this.capacity = options.capacity ?? 600;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sampleOnce(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
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

  private async sampleOnce(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const { services } = this.manager.status();
      const now = Date.now();
      await Promise.all(
        Object.values(services).map(async (status) => {
          if (status.state !== "running" || !status.pid) return;
          let buffer = this.buffers.get(status.name);
          // New run (or first sample) → reset the series so the chart starts at startedAt.
          if (!buffer || buffer.startedAt !== status.startedAt) {
            buffer = { startedAt: status.startedAt, samples: [] };
            this.buffers.set(status.name, buffer);
          }
          try {
            const tree = await readProcessTree(status.pid);
            buffer.samples.push({ t: now, cpu: tree.cpuPercent, rss: tree.rssMb });
            if (buffer.samples.length > this.capacity) {
              buffer.samples.splice(0, buffer.samples.length - this.capacity);
            }
          } catch {
            // ps may briefly fail right after spawn / during exit — skip this tick.
          }
        }),
      );
    } finally {
      this.sampling = false;
    }
  }
}
