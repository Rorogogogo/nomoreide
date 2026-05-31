import type { DashboardData, DatabaseConnection, ErrorIncident } from "@/lib/api";

export interface AiContextSelection {
  serviceNames: string[];
  databaseNames: string[];
  errorIds: number[];
  repositoryPaths: string[];
}

export function emptyAiContextSelection(): AiContextSelection {
  return {
    serviceNames: [],
    databaseNames: [],
    errorIds: [],
    repositoryPaths: [],
  };
}

export function hasAiContextSelection(selection: AiContextSelection): boolean {
  return (
    selection.serviceNames.length > 0 ||
    selection.databaseNames.length > 0 ||
    selection.errorIds.length > 0 ||
    selection.repositoryPaths.length > 0
  );
}

export function buildAiContextPrompt({
  dashboard,
  databases,
  incidents,
  note,
  selection,
}: {
  dashboard: DashboardData;
  databases: DatabaseConnection[];
  incidents: ErrorIncident[];
  note?: string;
  selection: AiContextSelection;
}): string {
  const sections = [
    buildServicesSection(dashboard, selection.serviceNames),
    buildDatabasesSection(databases, selection.databaseNames),
    buildErrorsSection(incidents, selection.errorIds),
    buildRepositoriesSection(dashboard, selection.repositoryPaths),
  ].filter(Boolean);

  return [
    "Diagnose this NoMoreIDE workspace context.",
    "Use the selected services, databases, incidents, and repositories together. Tell me what stands out, likely root causes, and the safest next steps.",
    "",
    `Workspace: ${dashboard.cwd}`,
    note?.trim() ? `Extra user context:\n${note.trim()}` : null,
    "",
    sections.join("\n\n---\n\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAiContextLabel({
  note,
  selection,
}: {
  note?: string;
  selection: AiContextSelection;
}): string {
  const parts = [
    plural(selection.serviceNames.length, "service"),
    plural(selection.databaseNames.length, "database"),
    plural(selection.errorIds.length, "error"),
    plural(selection.repositoryPaths.length, "repo"),
  ].filter(Boolean);
  const shortNote = note?.trim().replace(/\s+/g, " ");
  return shortNote
    ? `Diagnose: ${parts.join(", ")}. Note: ${shortNote.slice(0, 80)}`
    : `Diagnose: ${parts.join(", ")}`;
}

function buildServicesSection(dashboard: DashboardData, serviceNames: string[]): string | null {
  if (!serviceNames.length) return null;
  const services = serviceNames.map((name) => {
    const definition = dashboard.config.services.find((service) => service.name === name);
    const status = dashboard.runtime.services[name];
    const health = dashboard.health[name];
    const recentLogs = dashboard.logs
      .filter((entry) => entry.service === name)
      .slice(-8)
      .map((entry) => `${entry.timestamp} ${entry.stream}: ${entry.text}`);

    return [
      `Service: ${name}`,
      definition?.kind ? `kind: ${definition.kind}` : null,
      definition?.command ? `command: ${definition.command}` : null,
      definition?.cwd ? `cwd: ${definition.cwd}` : null,
      definition?.port ? `port: ${definition.port}` : null,
      status ? `state: ${status.state}` : "state: unknown",
      status?.pid ? `pid: ${status.pid}` : null,
      status?.url ? `url: ${status.url}` : null,
      status?.exitCode !== undefined && status.exitCode !== null
        ? `exitCode: ${status.exitCode}`
        : null,
      health ? `health: ${health.status} - ${health.summary}` : null,
      health?.agentContext ? `agent debug context:\n${health.agentContext}` : null,
      recentLogs.length ? `recent logs:\n${recentLogs.join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return ["Services", services.join("\n\n")].join("\n");
}

function buildDatabasesSection(
  databases: DatabaseConnection[],
  databaseNames: string[],
): string | null {
  if (!databaseNames.length) return null;
  const selected = databaseNames.map((name) => {
    const database = databases.find((item) => item.name === name);
    return [
      `Database: ${name}`,
      database?.engine ? `engine: ${database.engine}` : null,
      database?.url ? `url: ${database.url}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return ["Databases", selected.join("\n\n")].join("\n");
}

function buildErrorsSection(incidents: ErrorIncident[], errorIds: number[]): string | null {
  if (!errorIds.length) return null;
  const selected = errorIds.map((id) => {
    const incident = incidents.find((item) => item.id === id);
    if (!incident) return `Incident #${id}`;
    return [
      `Incident #${incident.id}`,
      `service: ${incident.service}`,
      `level: ${incident.level}`,
      `title: ${incident.title}`,
      incident.file ? `file: ${incident.file}${incident.line ? `:${incident.line}` : ""}` : null,
      `count: ${incident.count}`,
      `firstSeen: ${incident.firstSeen}`,
      `lastSeen: ${incident.lastSeen}`,
      incident.logExcerpt.length ? `log excerpt:\n${incident.logExcerpt.join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return ["Error Inbox", selected.join("\n\n")].join("\n");
}

function buildRepositoriesSection(
  dashboard: DashboardData,
  repositoryPaths: string[],
): string | null {
  if (!repositoryPaths.length) return null;
  const configured = repositoryOptions(dashboard);
  const currentPath = dashboard.git.selectedRepository?.path ?? dashboard.git.cwd;
  const files = dashboard.git.status?.files.map((file) => `${file.status}: ${file.path}`) ?? [];
  const repositories = repositoryPaths.map((path) => {
    const repo = configured.find((item) => item.path === path);
    const current = path === currentPath;
    return [
      `Repository: ${repo?.name ?? path.split("/").pop() ?? path}`,
      `path: ${path}`,
      current ? "current: yes" : "current: no",
      current
        ? files.length
          ? `changed files:\n${files.join("\n")}`
          : "changed files: none"
        : "changed files: not loaded for this repository in the current dashboard view",
    ].join("\n");
  });
  return ["Git Repositories", repositories.join("\n\n")].join("\n");
}

function repositoryOptions(dashboard: DashboardData): Array<{ name: string; path: string }> {
  if (dashboard.config.gitRepositories.length) return dashboard.config.gitRepositories;
  if (dashboard.git.selectedRepository) return [dashboard.git.selectedRepository];
  return [{ name: dashboard.git.cwd.split("/").pop() ?? "repository", path: dashboard.git.cwd }];
}

function plural(count: number, noun: string): string | null {
  if (!count) return null;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
