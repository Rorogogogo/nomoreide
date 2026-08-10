import { requestJson } from "./client.js";
import type { TerminalSessionInfo } from "./terminal-api.js";

export interface SshServerDefinition {
  host: string;
  name?: string;
  environment?: string;
}

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

export interface SshSetupStatus {
  publicKeys: string[];
  sshCopyIdAvailable: boolean;
}

export interface RemoteProcessMetric {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  rssMb: number;
  command: string;
}

export interface RemoteHostMetrics {
  host: string;
  hostname: string;
  platform: string;
  current: {
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
  };
  processes: RemoteProcessMetric[];
}

export async function listSshServers(): Promise<SshServerSummary[]> {
  const response = await requestJson<{ ok: true; servers: SshServerSummary[] }>(
    "/api/servers",
  );
  return response.servers;
}

export async function saveSshServer(server: SshServerDefinition): Promise<void> {
  await requestJson("/api/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(server),
  });
}

export async function removeSshServer(host: string): Promise<void> {
  await requestJson(`/api/servers/${encodeURIComponent(host)}`, { method: "DELETE" });
}

export async function probeSshServer(host: string): Promise<SshServerProbe> {
  const response = await requestJson<{ ok: true; probe: SshServerProbe }>(
    `/api/servers/${encodeURIComponent(host)}/probe`,
    { method: "POST" },
  );
  return response.probe;
}

export async function getRemoteHostMetrics(host: string): Promise<RemoteHostMetrics> {
  const response = await requestJson<{ ok: true; metrics: RemoteHostMetrics }>(
    `/api/servers/${encodeURIComponent(host)}/metrics`,
  );
  return response.metrics;
}

export async function openSshTerminal(host: string): Promise<TerminalSessionInfo> {
  const response = await requestJson<{ ok: true; session: TerminalSessionInfo }>(
    `/api/servers/${encodeURIComponent(host)}/terminal`,
    { method: "POST" },
  );
  return response.session;
}

export async function getSshSetupStatus(): Promise<SshSetupStatus> {
  const response = await requestJson<{ ok: true; setup: SshSetupStatus }>(
    "/api/servers/setup/status",
  );
  return response.setup;
}

export async function openSshSetupTerminal(
  action: "generate-key" | "install-key",
  host?: string,
): Promise<TerminalSessionInfo> {
  const response = await requestJson<{ ok: true; session: TerminalSessionInfo }>(
    "/api/servers/setup/terminal",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, host }),
    },
  );
  return response.session;
}
