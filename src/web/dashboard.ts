import { ConfigStore } from "../core/config-store.js";
import { GitManager, type GitStatus } from "../core/git-manager.js";
import { LogStore } from "../core/log-store.js";
import {
  getPortBindingStatus,
  type HostPortStatus,
} from "../core/port-utils.js";
import { ProcessManager } from "../core/process-manager.js";
import { computeServiceHealth } from "../core/service-health.js";
import type { TimelineStore } from "../core/timeline-store.js";
import type { NoMoreIdeConfig, ServiceHealth, ServiceStatus } from "../core/types.js";

export async function buildDashboardPayload(options: {
  configStore: ConfigStore;
  cwd: string;
  logStore: LogStore;
  manager: ProcessManager;
  timelineStore: TimelineStore;
}) {
  const config = await options.configStore.load();
  const firstService = config.services[0]?.name;
  const selectedGitRepository = getSelectedGitRepository(config);
  const gitCwd = selectedGitRepository?.path ?? options.cwd;
  const runtime = await options.manager.statusWithResources();
  const [gitStatus, branches, ports] = await Promise.all([
    readGitStatus(gitCwd),
    readGitBranches(gitCwd),
    buildPortOverview(config, runtime.services),
  ]);
  const health = buildHealthOverview({
    config,
    logStore: options.logStore,
    ports,
    runtimeServices: runtime.services,
  });

  return {
    ok: true,
    cwd: options.cwd,
    config,
    runtime,
    ports,
    health,
    timeline: options.timelineStore.read(120),
    logs: firstService ? options.logStore.read(firstService, 80) : [],
    git: {
      cwd: gitCwd,
      selectedRepository: selectedGitRepository ?? null,
      status: gitStatus ?? null,
      branches: branches ?? [],
      error: gitStatus ? undefined : `Not a Git repository: ${gitCwd}`,
    },
  };
}

interface PortOverview {
  port: number;
  available: boolean;
  hosts: HostPortStatus[];
  state: "available" | "managed" | "occupied";
  services: string[];
  urls: string[];
}

function buildHealthOverview(options: {
  config: NoMoreIdeConfig;
  logStore: LogStore;
  ports: PortOverview[];
  runtimeServices: Record<string, ServiceStatus>;
}): Record<string, ServiceHealth> {
  return Object.fromEntries(
    options.config.services.map((service) => [
      service.name,
      computeServiceHealth({
        service,
        status: options.runtimeServices[service.name],
        ports: options.ports.filter((port) => port.services.includes(service.name)),
        logs: options.logStore.read(service.name, 80),
      }),
    ]),
  );
}

async function buildPortOverview(
  config: NoMoreIdeConfig,
  runtimeServices: Record<string, ServiceStatus>,
): Promise<PortOverview[]> {
  const ports = new Map<number, { services: Set<string>; urls: Set<string> }>();

  for (const service of config.services) {
    if (service.port) {
      const entry = getPortEntry(ports, service.port);
      entry.services.add(service.name);
    }
  }

  for (const status of Object.values(runtimeServices)) {
    if (!status.url) continue;
    const port = portFromUrl(status.url);
    if (!port) continue;
    const entry = getPortEntry(ports, port);
    entry.services.add(status.name);
    entry.urls.add(status.url);
  }

  return Promise.all(
    [...ports.entries()]
      .sort(([left], [right]) => left - right)
      .map(async ([port, entry]) => {
        const binding = await getPortBindingStatus(port);
        const managed = [...entry.services].some((serviceName) => {
          const status = runtimeServices[serviceName];
          const urlPort = portFromUrl(status?.url);
          return (
            status?.state === "running" &&
            (urlPort === port ||
              (urlPort === undefined &&
                config.services.some(
                  (service) => service.name === serviceName && service.port === port,
                )))
          );
        });

        return {
          port,
          available: binding.available,
          hosts: binding.hosts,
          state: managed ? "managed" : binding.available ? "available" : "occupied",
          services: [...entry.services].sort(),
          urls: [...entry.urls].sort(),
        };
      }),
  );
}

function getPortEntry(
  ports: Map<number, { services: Set<string>; urls: Set<string> }>,
  port: number,
) {
  let entry = ports.get(port);
  if (!entry) {
    entry = { services: new Set<string>(), urls: new Set<string>() };
    ports.set(port, entry);
  }
  return entry;
}

function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : undefined;
  } catch {
    return undefined;
  }
}

export function getSelectedGitRepository(
  config: Awaited<ReturnType<ConfigStore["load"]>>,
) {
  return (
    config.gitRepositories.find(
      (repository) => repository.name === config.selectedGitRepository,
    ) ?? config.gitRepositories[0]
  );
}

async function readGitStatus(cwd: string): Promise<GitStatus | undefined> {
  try {
    return await new GitManager(cwd).status();
  } catch {
    return undefined;
  }
}

async function readGitBranches(cwd: string) {
  try {
    return await new GitManager(cwd).branches();
  } catch {
    return undefined;
  }
}

export async function readGitDiff(
  cwd: string,
  path: string,
): Promise<string | undefined> {
  try {
    return await new GitManager(cwd).diff(path);
  } catch {
    return undefined;
  }
}

export async function selectedGitCwd(
  configStore: ConfigStore,
  fallbackCwd: string,
): Promise<string> {
  const config = await configStore.load();
  return getSelectedGitRepository(config)?.path ?? fallbackCwd;
}
