import type { ErrorIncident, IncidentLevel } from "@/lib/api";

export interface IncidentFilters {
  levels: IncidentLevel[];
  services: string[];
}

export function incidentMatchesQuery(
  incident: ErrorIncident,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  return [
    incident.service,
    incident.title,
    incident.file ?? "",
    ...incident.logExcerpt,
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

export function filterIncidents(
  incidents: ErrorIncident[],
  query: string,
  filters: IncidentFilters,
): ErrorIncident[] {
  const levels = new Set(filters.levels);
  const services = new Set(filters.services);

  return incidents.filter(
    (incident) =>
      incidentMatchesQuery(incident, query) &&
      (levels.size === 0 || levels.has(incident.level)) &&
      (services.size === 0 || services.has(incident.service)),
  );
}

export function incidentFilterOptions(incidents: ErrorIncident[]): {
  levels: IncidentLevel[];
  services: string[];
} {
  return {
    levels: [...new Set(incidents.map(({ level }) => level))].sort(),
    services: [...new Set(incidents.map(({ service }) => service))].sort(),
  };
}

export function activeIncidentFilterCount(filters: IncidentFilters): number {
  return filters.levels.length + filters.services.length;
}
