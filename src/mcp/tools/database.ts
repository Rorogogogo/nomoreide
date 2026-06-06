import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { isReadStatement } from "../../core/db/driver.js";
import { stringify, type ToolContext } from "./context.js";

/**
 * Returned to the agent when a write hits the read-only query path. This is the
 * contextual teach for the dock's write-staging convention — it costs nothing
 * until the agent actually tries to change data, and tells it to reply with a
 * `sql-write` block instead of executing or narrating console steps. The dock
 * parses that block into an "Open in SQL console" button (see the web client's
 * `chat/message-options.tsx`); the write still goes through the human-only
 * console with its unlock + affected-rows preview.
 */
function writeStagingGuidance(connection: string): string {
  return [
    "This connection is read-only, so that statement was NOT executed.",
    "Don't run it here, and don't tell the user to open the console and type it",
    "themselves. Instead reply with the exact statement in a fenced block tagged",
    "`sql-write` followed by the connection name:",
    "",
    "```sql-write " + connection,
    "UPDATE … SET … WHERE …;",
    "```",
    "",
    "NoMoreIDE turns that into an \"Open in SQL console\" button that stages the",
    "statement in the human-only write console, where the user unlocks writes and",
    "reviews an affected-rows preview before committing. Emit exactly one",
    "statement, and always scope UPDATE/DELETE with a WHERE clause.",
  ].join("\n");
}

export const DATABASE_TOOL_NAMES = [
  "nomoreide_list_databases",
  "nomoreide_db_tables",
  "nomoreide_db_sample",
  "nomoreide_db_query",
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

const querySchema = connectionSchema.extend({
  sql: z
    .string()
    .min(1)
    .describe("A read-only SELECT-style statement. Writes are rejected server-side."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Max rows to return (default 100)."),
});

/**
 * DB Peek tools: read-only access to the user's registered database
 * connections. Scoped to connections in ConfigStore; `nomoreide_db_query` runs
 * SQL inside a read-only transaction, so writes are rejected by the server.
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

  server.addTool({
    name: "nomoreide_db_query",
    description:
      "Run a read-only SQL query against a registered connection and return the rows. " +
      "Read-only at the transaction level — INSERT/UPDATE/DELETE/DDL are rejected. To " +
      "make a change, don't run it here and don't tell the user to open the console " +
      "by hand: reply with the statement in a ```sql-write <connection>``` fenced " +
      "block, which the dock renders as an 'Open in SQL console' button to review and run.",
    parameters: querySchema,
    execute: async ({ connection, sql, limit }) => {
      try {
        return stringify(await dbPeek.runQuery(connection, sql, limit ?? 100));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        // A write rejected by the read-only transaction (every engine phrases it
        // with "read only/readonly") becomes a teach, not a bare error.
        if (/read[\s-]?only/i.test(message) || !isReadStatement(sql)) {
          return writeStagingGuidance(connection);
        }
        throw caught;
      }
    },
  });
}
