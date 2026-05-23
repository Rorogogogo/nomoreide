import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { stringify, type ToolContext } from "./context.js";

export const DATABASE_TOOL_NAMES = [
  "nomoreide_list_databases",
  "nomoreide_db_tables",
  "nomoreide_db_sample",
] as const;

const connectionSchema = z.object({
  connection: z
    .string()
    .min(1)
    .describe("Connection name from nomoreide_list_databases."),
});

const sampleSchema = connectionSchema.extend({
  table: z
    .string()
    .min(1)
    .describe("Qualified table name from nomoreide_db_tables (e.g. public.users)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Max rows to sample (default 100)."),
});

/**
 * DB Peek tools: read-only browsing of the user's registered database
 * connections. Scoped to connections in ConfigStore — no arbitrary SQL.
 */
export function registerDatabaseTools(server: FastMCP, ctx: ToolContext): void {
  const { dbPeek } = ctx;

  server.addTool({
    name: "nomoreide_list_databases",
    description:
      "List registered read-only database connections (Postgres / MySQL / SQLite). Passwords are masked.",
    parameters: z.object({}),
    execute: async () => stringify(await dbPeek.listConnections()),
  });

  server.addTool({
    name: "nomoreide_db_tables",
    description: "List the tables and views in a registered database connection.",
    parameters: connectionSchema,
    execute: async ({ connection }) =>
      stringify(await dbPeek.listTables(connection)),
  });

  server.addTool({
    name: "nomoreide_db_sample",
    description:
      "Sample rows from a table (read-only) with its column schema — the 'explain this data to the agent' payload.",
    parameters: sampleSchema,
    execute: async ({ connection, table, limit }) =>
      stringify(await dbPeek.sampleRows(connection, table, limit ?? 100)),
  });
}
