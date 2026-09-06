import type { SavedDatabaseQuery, OpenQueryTab, QueryWorkspace } from "./query-types";

/**
 * Ids, default names, and the readers that turn whatever `localStorage` holds
 * back into a workspace.
 *
 * The normalisers are deliberately total: persisted state is user data that a
 * previous version wrote, so an unreadable value falls back rather than
 * throwing and taking the SQL console down with it.
 */

export function createOpenQueryId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSavedQueryId(): string {
  return `query-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultSavedQueryName(sql: string, fallback: string): string {
  const firstLine = sql.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ") ?? "";
  return firstLine.slice(0, 60) || fallback;
}

export function normalizeWorkspace(value: unknown, fallback: QueryWorkspace): QueryWorkspace {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<QueryWorkspace>;
  if (!Array.isArray(candidate.tabs)) return fallback;
  const tabs = candidate.tabs.filter((tab): tab is OpenQueryTab => {
    if (!tab || typeof tab !== "object") return false;
    const entry = tab as Partial<OpenQueryTab>;
    return typeof entry.id === "string"
      && (entry.savedQueryId === null || typeof entry.savedQueryId === "string")
      && typeof entry.sql === "string";
  });
  if (tabs.length === 0) return fallback;
  const activeId = typeof candidate.activeId === "string"
    && tabs.some((tab) => tab.id === candidate.activeId)
    ? candidate.activeId
    : tabs[0].id;
  return { activeId, tabs };
}

export function normalizeSavedQueries(value: unknown): SavedDatabaseQuery[] {
  if (!Array.isArray(value)) return [];
  return value.filter((query): query is SavedDatabaseQuery => {
    if (!query || typeof query !== "object") return false;
    const candidate = query as Partial<SavedDatabaseQuery>;
    return typeof candidate.connection === "string"
      && typeof candidate.id === "string"
      && typeof candidate.name === "string"
      && typeof candidate.sql === "string"
      && typeof candidate.updatedAt === "number";
  });
}
