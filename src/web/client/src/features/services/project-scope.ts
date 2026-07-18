import type { DashboardData, GitRepositoryDefinition } from "@/lib/api";

/** True when `cwd` is the repo root or a directory inside it. */
export function pathInScope(cwd: string | undefined, repoPath: string): boolean {
  if (!cwd) return false;
  const root = repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath;
  return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * Narrow the dashboard payload to one project: services whose cwd lives under
 * the repo, plus the runtime/health/log/port/timeline entries that belong to
 * them. Services without a cwd only appear in the "All projects" scope.
 */
export function scopeDashboard(
  data: DashboardData,
  repo: GitRepositoryDefinition,
): DashboardData {
  const services = data.config.services.filter((service) =>
    pathInScope(service.cwd, repo.path),
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
