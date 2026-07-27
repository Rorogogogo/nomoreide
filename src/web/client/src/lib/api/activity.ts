import { requestJson } from "./client.js";

export interface DiskUsage {
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface HostMetricSample {
  t: number;
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryUsedPercent: number;
  loadAverage: [number, number, number] | null;
  uptimeSeconds: number;
  logicalCpuCount: number;
  disk: DiskUsage | null;
}

export interface ServiceActivityMetric {
  service: string;
  startedAt?: string;
  sampledAt: number;
  cpuPercent: number;
  rssMb: number;
  processCount: number;
}

export interface ActivityMetrics {
  sampleIntervalMs: number;
  host: {
    current: HostMetricSample | null;
    samples: HostMetricSample[];
  };
  services: Record<string, ServiceActivityMetric>;
}

export async function getActivityMetrics(): Promise<ActivityMetrics> {
  const response = await requestJson<{ ok: true; metrics: ActivityMetrics }>(
    "/api/metrics",
  );
  return response.metrics;
}
