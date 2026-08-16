import { basename } from "node:path";
import { isGitWorktree, type ConfigStore } from "../core/config-store.js";
import { GitManager, type GitStatus } from "../core/git-manager.js";
import type { LogStore } from "../core/log-store.js";
import {
  getPortBindingStatus,
  type HostPortStatus,
} from "../core/port-utils.js";
import type { ProcessManager } from "../core/process-manager.js";
import { computeServiceHealth } from "../core/service-health.js";
import type { TimelineStore } from "../core/timeline-store.js";
import type {
  LogEntry,
  NoMoreIdeConfig,
  ServiceHealth,
  ServiceStatus,
  TimelineEvent,
} from "../core/types.js";

/** How much of each service's tail health reasons over. */
const LOG_TAIL = 80;

/**
 * How much of each service's tail rides along in the payload.
 *
 * Shorter than what health reads, because this one is multiplied by every
 * service that has ever logged and goes over the wire on every poll. Forty
 * lines is more than the Logs panel shows and more than the agent context
 * quotes, so nothing downstream is short of material.
 */
const PAYLOAD_TAIL = 40;

export async function buildDashboardPayload(options: {
  configStore: ConfigStore;
  cwd: string;
  logStore: LogStore;
  manager: ProcessManager;
  timelineStore: TimelineStore;
}) {
  let config = await options.configStore.load();
  let selectedGitRepository = getSelectedGitRepository(config);

  // If the user has no Git projects registered yet, auto-adopt the process cwd
  // when it's a real Git worktree. If it isn't, leave the repo unselected so the
  // UI can show its empty state (matching the Database tab) instead of pointing
  // at a non-repo folder.
  if (!selectedGitRepository && config.gitRepositories.length === 0) {
    if (await isGitWorktree(options.cwd)) {
      try {
        config = await options.configStore.registerGitRepository({
          name: basename(options.cwd) || "repo",
          path: options.cwd,
        });
        selectedGitRepository = getSelectedGitRepository(config);
      } catch {
        // Fall through — empty state will be shown.
      }
    }
  }

  const gitCwd = selectedGitRepository
    ? await selectedGitCwd(options.configStore, selectedGitRepository.path)
    : "";
  const runtime = await options.manager.statusWithResources();
  const [gitStatus, branches, ports] = await Promise.all([
    gitCwd ? readGitStatus(gitCwd) : Promise.resolve(undefined),
    gitCwd ? readGitBranches(gitCwd) : Promise.resolve(undefined),
    buildPortOverview(config, runtime.services),
  ]);
  const timeline = options.timelineStore.read(120);
  const serviceLogs = readServiceLogs(config, options.logStore);
  const health = buildHealthOverview({
    config,
    ports,
    runtimeServices: runtime.services,
    serviceLogs,
    timeline,
  });

  return {
    ok: true,
    cwd: options.cwd,
    config,
    runtime,
    ports,
    health,
    timeline,
    logs: mergeServiceLogs(serviceLogs),
    git: {
      cwd: gitCwd,
      selectedRepository: selectedGitRepository ?? null,
      status: gitStatus ?? null,
      branches: branches ?? [],
      error: !gitCwd
        ? undefined
        : gitStatus
          ? undefined
          : `Not a Git repository: ${gitCwd}`,
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

/**
 * Every registered service's tail, read once.
 *
 * Health wants it per service and the Output panel wants the liveliest one, so
 * reading the ring buffer twice would only be a way for the two to disagree
 * about the same in-memory array.
 */
function readServiceLogs(
  config: NoMoreIdeConfig,
  logStore: LogStore,
): Map<string, LogEntry[]> {
  return new Map(
    config.services.map((service) => [service.name, logStore.read(service.name, LOG_TAIL)]),
  );
}

/**
 * Every service's tail, in one chronological list.
 *
 * This field used to carry a single service — `config.services[0]`, which is
 * registration order and therefore arbitrary. It meant the Logs panel could
 * only ever show one service, and *which* one came down to a race: two services
 * started 200ms apart, and the later one hid the other completely.
 *
 * Carrying all of them lets the panel offer a tab per service and lets the
 * agent context quote whichever service is being asked about, without either
 * needing a request of its own. Consumers that want one service filter by
 * `entry.service` — `project-scope.ts` already did.
 *
 * Timestamps are compared as strings because `LogStore` writes them all with
 * `toISOString()` — same width, same UTC offset, so lexical order is
 * chronological order. The sort is stable, so a service's own lines keep their
 * relative order even when a burst shares a millisecond.
 */
export function mergeServiceLogs(serviceLogs: Map<string, LogEntry[]>): LogEntry[] {
  return [...serviceLogs.values()]
    .flatMap((lines) => lines.slice(-PAYLOAD_TAIL))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}

function buildHealthOverview(options: {
  config: NoMoreIdeConfig;
  ports: PortOverview[];
  runtimeServices: Record<string, ServiceStatus>;
  serviceLogs: Map<string, LogEntry[]>;
  timeline: TimelineEvent[];
}): Record<string, ServiceHealth> {
  return Object.fromEntries(
    options.config.services.map((service) => [
      service.name,
      computeServiceHealth({
        service,
        status: options.runtimeServices[service.name],
        ports: options.ports.filter((port) => port.services.includes(service.name)),
        logs: options.serviceLogs.get(service.name) ?? [],
        timeline: options.timeline.filter((event) => event.service === service.name),
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
  const repository = getSelectedGitRepository(config);
  if (!repository) return fallbackCwd;
  if (
    repository.activeWorktreePath &&
    await isGitWorktree(repository.activeWorktreePath)
  ) {
    return repository.activeWorktreePath;
  }
  return repository.path;
}
