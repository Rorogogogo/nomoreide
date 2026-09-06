/**
 * The SQL console's persisted shapes: a saved query, an open tab, and the
 * workspace holding them.
 *
 * Their own module so the tabs, the dialogs and the storage readers share one
 * definition instead of importing each other for it.
 */

export interface SavedDatabaseQuery {
  connection: string;
  id: string;
  name: string;
  sql: string;
  updatedAt: number;
}

export interface OpenQueryTab {
  id: string;
  savedQueryId: string | null;
  sql: string;
}

export interface QueryWorkspace {
  activeId: string;
  tabs: OpenQueryTab[];
}
