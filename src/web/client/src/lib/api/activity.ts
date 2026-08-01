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
  systemProcesses?: SystemProcess[];
}

export type ProcessProtection = "managed" | "permission" | "system" | "this-app";

export interface SystemProcess {
  pid: number;
  ppid: number;
  uid: number;
  user: string;
  cpuPercent: number;
  rssMb: number;
  command: string;
  managedService?: string;
  canTerminate: boolean;
  protection?: ProcessProtection;
}

export async function getActivityMetrics(
  options: { includeProcesses?: boolean } = {},
): Promise<ActivityMetrics> {
  const response = await requestJson<{ ok: true; metrics: ActivityMetrics }>(
    options.includeProcesses ? "/api/metrics?includeProcesses=1" : "/api/metrics",
  );
  return response.metrics;
}

export async function terminateSystemProcess(
  pid: number,
  expectedCommand: string,
): Promise<void> {
  await requestJson("/api/processes/terminate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pid, expectedCommand }),
  });
}
