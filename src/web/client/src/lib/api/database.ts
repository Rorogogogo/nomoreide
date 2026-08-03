/**
 * Database API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as the
 * named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { DatabaseApi } from "./database-api.js";
import { httpDatabaseApi } from "./database-http.js";
import { tauriDatabaseApi } from "./database-tauri.js";

const api: DatabaseApi = isTauri() ? tauriDatabaseApi : httpDatabaseApi;

export const {
  listDatabases,
  detectDatabases,
  addDatabase,
  testDatabase,
  deleteDatabase,
  getDatabaseTables,
  getDatabaseCapabilities,
  getDatabaseSchemas,
  getDatabaseObjects,
  getDatabaseObjectDetails,
  getDatabaseObjectRows,
  runDatabaseQuery,
  setDatabaseWriteAccess,
  executeDatabaseWrite,
  deleteDatabaseRows,
  getDatabaseRows,
} = api;

export type {
  DatabaseApi,
  DatabaseEngine,
  DatabaseConnection,
  DetectedConnection,
  TableRef,
  DatabaseCapabilities,
  DatabaseSchema,
  DatabaseObjectKind,
  DatabaseObject,
  DatabaseObjectDetails,
  ColumnInfo,
  RowSample,
  QueryResult,
  WriteOutcome,
  DeleteDatabaseRowsInput,
  DatabaseRowKeyValue,
} from "./database-api.js";
