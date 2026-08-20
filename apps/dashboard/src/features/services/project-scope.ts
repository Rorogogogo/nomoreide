import type { DashboardData, GitRepositoryDefinition, ServiceDefinition } from "@/lib/api";

/** True when `cwd` is the repo root or a directory inside it. */
export function pathInScope(cwd: string | undefined, repoPath: string): boolean {
  if (!cwd) return false;
  const root = repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath;
  return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * Which project a service belongs to. An explicit `projectPath` wins over the
 * cwd inference and is the only way to place a service whose cwd is on another
 * machine — a remote log tail at `/var/www/app` can't sit under a local repo
 * root, so inference would strand it outside every project.
 *
 * An explicit assignment is also authoritative in the negative: a service
 * pinned to project A stays out of project B even when its cwd happens to sit
 * under B, otherwise pinning could not move a service that already inferred.
 */
export function serviceInScope(service: ServiceDefinition, repoPath: string): boolean {
  if (service.projectPath) return pathInScope(service.projectPath, repoPath);
  return pathInScope(service.cwd, repoPath);
}

/**
 * Services that land in no project at all — neither pinned nor inferable from
 * cwd. They are reachable only in the "All projects" scope, so the UI has to
 * offer them somewhere or they are effectively lost.
 */
export function unassignedServices(
  services: ServiceDefinition[],
  repositories: GitRepositoryDefinition[],
): ServiceDefinition[] {
  return services.filter(
    (service) => !repositories.some((repository) => serviceInScope(service, repository.path)),
  );
}

/**
 * Whether a DB connection should show under a project scope. Unlike services,
 * unassigned connections (no projectPath) stay visible in every scope — most
 * start unclassified, and the lens shouldn't hide what hasn't been sorted yet.
 */
export function connectionInScope(
  projectPath: string | undefined,
  scopePath: string | null,
): boolean {
  if (!scopePath || !projectPath) return true;
  return pathInScope(projectPath, scopePath);
}

/**
 * Narrow the dashboard payload to one project: the services that belong to the
 * repo, plus the runtime/health/log/port/timeline entries that belong to them.
 * A service matching no project appears only in the "All projects" scope —
 * a scoped service list drives start/stop, so a false member is worse there
 * than a missing one.
 */
export function scopeDashboard(
  data: DashboardData,
  repo: GitRepositoryDefinition,
): DashboardData {
  const services = data.config.services.filter((service) =>
    serviceInScope(service, repo.path),
  );
  const names = new Set(services.map((service) => service.name));

  const bundles = data.config.bundles
    .map((bundle) => ({
      ...bundle,
      services: bundle.services.filter((name) => names.has(name)),
    }))
    .filter((bundle) => bundle.services.length > 0);

  const runtimeServices = Object.fromEntries(
    Object.entries(data.runtime.services).filter(([name]) => names.has(name)),
  );
  const health = Object.fromEntries(
    Object.entries(data.health).filter(([name]) => names.has(name)),
  );

  return {
    ...data,
    config: { ...data.config, services, bundles },
    runtime: { services: runtimeServices },
    health,
    ports: data.ports.filter((port) =>
      port.services.some((name) => names.has(name)),
    ),
    logs: data.logs.filter((entry) => names.has(entry.service)),
    timeline: data.timeline.filter(
      (event) => !event.service || names.has(event.service),
    ),
  };
}
