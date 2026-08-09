import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SshServerDefinition } from "./types.js";

const execFileAsync = promisify(execFile);
const SSH_TIMEOUT_MS = 7_000;
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
] as const;

export interface SshServerSummary extends SshServerDefinition {
  discovered: boolean;
  saved: boolean;
}

export interface SshServerProbe {
  host: string;
  reachable: boolean;
  latencyMs: number;
  hostname?: string;
  platform?: string;
  error?: string;
}

export interface RemoteProcessMetric {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  rssMb: number;
  command: string;
}

export interface RemoteHostMetricSample {
  t: number;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryUsedPercent: number;
  loadAverage: [number, number, number];
  uptimeSeconds: number;
  logicalCpuCount: number;
  disk: {
    path: string;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  } | null;
}

export interface RemoteHostMetrics {
  host: string;
  hostname: string;
  platform: string;
  current: RemoteHostMetricSample;
  processes: RemoteProcessMetric[];
}

/** Explicit, concrete aliases from ~/.ssh/config. Wildcard patterns are omitted. */
export function parseSshConfigHosts(contents: string): string[] {
  const hosts = new Set<string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const candidate of (match[1] ?? "").split(/\s+/)) {
      if (!candidate || /[*?!]/.test(candidate) || candidate.startsWith("-")) continue;
      hosts.add(candidate);
    }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

export async function discoverSshHosts(
  configPath = join(homedir(), ".ssh", "config"),
): Promise<string[]> {
  const contents = await readFile(configPath, "utf8").catch(() => "");
  return parseSshConfigHosts(contents);
}

export function mergeSshServers(
  saved: SshServerDefinition[],
  discoveredHosts: string[],
): SshServerSummary[] {
  const savedByHost = new Map(saved.map((server) => [server.host, server]));
  const hosts = new Set([...discoveredHosts, ...savedByHost.keys()]);
  return [...hosts]
    .sort((a, b) => a.localeCompare(b))
    .map((host) => ({
      host,
      ...savedByHost.get(host),
      discovered: discoveredHosts.includes(host),
      saved: savedByHost.has(host),
    }));
}

export async function probeSshServer(host: string): Promise<SshServerProbe> {
  assertSafeSshHost(host);
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync(
      "ssh",
      [...SSH_OPTIONS, host, "printf 'NMI\\t'; hostname; uname -s"],
      { timeout: SSH_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
    const lines = stdout.trim().split(/\r?\n/);
    const first = lines[0]?.split("\t") ?? [];
    if (first[0] !== "NMI") throw new Error("Remote probe returned an unexpected response.");
    return {
      host,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      hostname: first[1]?.trim() || undefined,
      platform: lines[1]?.trim() || undefined,
    };
  } catch (error) {
    return {
      host,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: conciseSshError(error),
    };
  }
}

export async function readRemoteHostMetrics(host: string): Promise<RemoteHostMetrics> {
  assertSafeSshHost(host);
  const { stdout } = await execFileAsync(
    "ssh",
    [...SSH_OPTIONS, host, REMOTE_METRICS_COMMAND],
    { timeout: SSH_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
  );
  return parseRemoteMetrics(host, stdout, Date.now());
}

export function parseRemoteMetrics(
  host: string,
  output: string,
  sampledAt: number,
): RemoteHostMetrics {
  const lines = output.split(/\r?\n/);
  const values = new Map<string, string[]>();
  const processes: RemoteProcessMetric[] = [];
  let readingProcesses = false;
  for (const line of lines) {
    if (line === "NMI_PROCESSES") {
      readingProcesses = true;
      continue;
    }
    if (readingProcesses) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      processes.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        user: match[3] ?? "",
        cpuPercent: Number(match[4]),
        rssMb: Number(match[5]) / 1024,
        command: match[6] ?? "",
      });
      continue;
    }
    const [key, ...rest] = line.split("\t");
    if (key?.startsWith("NMI_")) values.set(key, rest);
  }

  const meta = required(values, "NMI_META", 2);
  const cpu = numberAt(values, "NMI_CPU", 0);
  const memory = required(values, "NMI_MEMORY", 2).map(Number);
  const load = required(values, "NMI_LOAD", 3).map(Number) as [number, number, number];
  const uptimeSeconds = numberAt(values, "NMI_UPTIME", 0);
  const logicalCpuCount = numberAt(values, "NMI_CPUS", 0);
  const diskValues = values.get("NMI_DISK")?.map(Number);
  const memoryTotalBytes = memory[0] * 1024;
  const memoryAvailableBytes = memory[1] * 1024;
  const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryAvailableBytes);
  const disk = diskValues && diskValues.length >= 3
    ? {
        path: "/",
        totalBytes: diskValues[0] * 1024,
        usedBytes: diskValues[1] * 1024,
        availableBytes: diskValues[2] * 1024,
        usedPercent: percent(diskValues[1], diskValues[0]),
      }
    : null;

  return {
    host,
    hostname: meta[0] ?? host,
    platform: meta[1] ?? "Linux",
    current: {
      t: sampledAt,
      cpuPercent: cpu,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryUsedPercent: percent(memoryUsedBytes, memoryTotalBytes),
      loadAverage: load,
      uptimeSeconds,
      logicalCpuCount,
      disk,
    },
    processes,
  };
}

function assertSafeSshHost(host: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(host)) {
    throw new Error("SSH host must be a host name or ~/.ssh/config alias.");
  }
}

function conciseSshError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error ? String(error.stderr).trim() : "";
  return (stderr || error.message).split(/\r?\n/).at(-1) ?? error.message;
}

function required(values: Map<string, string[]>, key: string, length: number): string[] {
  const value = values.get(key);
  if (!value || value.length < length) {
    throw new Error(`Remote metrics response is missing ${key}.`);
  }
  return value;
}

function numberAt(values: Map<string, string[]>, key: string, index: number): number {
  const value = Number(required(values, key, index + 1)[index]);
  if (!Number.isFinite(value)) throw new Error(`Remote metrics response has invalid ${key}.`);
  return value;
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (value / total) * 100)) * 10) / 10;
}

// Linux-first, read-only probe. Output is deliberately tab/line based so the
// remote host needs only POSIX sh, awk, ps, and procfs — not Node or Python.
const REMOTE_METRICS_COMMAND = String.raw`LC_ALL=C sh -c '
read_cpu() { awk '\''/^cpu / { idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print idle, total; exit }'\'' /proc/stat; }
set -- $(read_cpu); idle1=$1; total1=$2
sleep 0.2
set -- $(read_cpu); idle2=$1; total2=$2
cpu=$(awk -v i1="$idle1" -v t1="$total1" -v i2="$idle2" -v t2="$total2" '\''BEGIN { d=t2-t1; if (d<=0) print "0.0"; else printf "%.1f", (1-(i2-i1)/d)*100 }'\'')
mem_total=$(awk '\''/^MemTotal:/ {print $2}'\'' /proc/meminfo)
mem_available=$(awk '\''/^MemAvailable:/ {print $2}'\'' /proc/meminfo)
set -- $(cat /proc/loadavg); load1=$1; load5=$2; load15=$3
set -- $(cat /proc/uptime); uptime=$1
set -- $(df -Pk / | tail -n 1); disk_total=$2; disk_used=$3; disk_available=$4
printf "NMI_META\t%s\t%s\n" "$(hostname)" "$(uname -s)"
printf "NMI_CPU\t%s\n" "$cpu"
printf "NMI_MEMORY\t%s\t%s\n" "$mem_total" "$mem_available"
printf "NMI_LOAD\t%s\t%s\t%s\n" "$load1" "$load5" "$load15"
printf "NMI_UPTIME\t%s\n" "$uptime"
printf "NMI_CPUS\t%s\n" "$(getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
printf "NMI_DISK\t%s\t%s\t%s\n" "$disk_total" "$disk_used" "$disk_available"
printf "NMI_PROCESSES\n"
ps -eo pid=,ppid=,user=,pcpu=,rss=,args= --sort=-pcpu | head -n 101
'`;
