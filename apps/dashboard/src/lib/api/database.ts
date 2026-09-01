/** Database API entry point shared by browser and desktop. */
import type { DatabaseApi } from "./database-api.js";
import { httpDatabaseApi } from "./database-http.js";

const api: DatabaseApi = httpDatabaseApi;

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
  exportDatabaseObject,
  runDatabaseQuery,
  setDatabaseWriteAccess,
  executeDatabaseWrite,
  deleteDatabaseRows,
  getDatabaseRows,
} = api;

export type {
  DatabaseApi,
  DatabaseEngine,
  DatabaseExportFormat,
  DatabaseExportResult,
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
  RowBrowseQuery,
  RowFilter,
  RowFilterOperator,
  QueryResult,
  WriteOutcome,
  DeleteDatabaseRowsInput,
  DatabaseRowKeyValue,
} from "./database-api.js";
