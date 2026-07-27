import { statfs } from "node:fs/promises";
import {
  cpus,
  freemem,
  loadavg,
  platform,
  totalmem,
  uptime,
  type CpuInfo,
} from "node:os";

export interface CpuTimes {
  idle: number;
  total: number;
}

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

export interface HostMetricsReader {
  cpuInfo(): CpuInfo[];
  diskUsage(path: string): Promise<DiskUsage>;
  freeMemoryBytes(): number;
  loadAverage(): [number, number, number] | null;
  totalMemoryBytes(): number;
  uptimeSeconds(): number;
}

export class HostMetricsCollector {
  private previousCpu?: CpuTimes;

  constructor(
    private readonly path: string,
    private readonly reader: HostMetricsReader = defaultHostMetricsReader,
  ) {}

  async sample(now = Date.now()): Promise<HostMetricSample> {
    const cpuInfo = this.reader.cpuInfo();
    const currentCpu = summarizeCpuTimes(cpuInfo);
    const cpuPercent = calculateCpuPercent(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;

    const memoryTotalBytes = Math.max(0, this.reader.totalMemoryBytes());
    const memoryFreeBytes = clamp(this.reader.freeMemoryBytes(), 0, memoryTotalBytes);
    const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryFreeBytes);
    const disk = await this.reader.diskUsage(this.path).catch(() => null);

    return {
      t: now,
      cpuPercent,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryUsedPercent: percent(memoryUsedBytes, memoryTotalBytes),
      loadAverage: this.reader.loadAverage(),
      uptimeSeconds: Math.max(0, this.reader.uptimeSeconds()),
      logicalCpuCount: cpuInfo.length,
      disk,
    };
  }
}

export function summarizeCpuTimes(cpuInfo: CpuInfo[]): CpuTimes {
  return cpuInfo.reduce<CpuTimes>(
    (summary, cpu) => {
      const total =
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.idle +
        cpu.times.irq;
      return {
        idle: summary.idle + cpu.times.idle,
        total: summary.total + total,
      };
    },
    { idle: 0, total: 0 },
  );
}

export function calculateCpuPercent(
  previous: CpuTimes | undefined,
  current: CpuTimes,
): number | null {
  if (!previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return roundOne(clamp((1 - idleDelta / totalDelta) * 100, 0, 100));
}

export async function readDiskUsage(path: string): Promise<DiskUsage> {
  const stats = await statfs(path);
  const blockSize = Number(stats.bsize);
  const totalBytes = blockSize * Number(stats.blocks);
  const availableBytes = blockSize * Number(stats.bavail);
  const usedBytes = Math.max(0, totalBytes - blockSize * Number(stats.bfree));
  return {
    path,
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent: percent(usedBytes, totalBytes),
  };
}

const defaultHostMetricsReader: HostMetricsReader = {
  cpuInfo: cpus,
  diskUsage: readDiskUsage,
  freeMemoryBytes: freemem,
  loadAverage: () => {
    if (platform() === "win32") return null;
    const [one, five, fifteen] = loadavg();
    return [one ?? 0, five ?? 0, fifteen ?? 0];
  },
  totalMemoryBytes: totalmem,
  uptimeSeconds: uptime,
};

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return roundOne(clamp((value / total) * 100, 0, 100));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
