import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { isReadStatement } from "../../core/db/driver.js";
import { stringify, type ToolContext } from "./context.js";

/**
 * Returned to the agent when a write hits the read-only query path. This is the
 * contextual teach for the raw-terminal workflow. It costs nothing until the
 * agent actually tries to change data and keeps execution in the human-only,
 * locked SQL console with its affected-rows preview.
 */
function writeStagingGuidance(connection: string): string {
  return [
    "This connection is read-only, so that statement was NOT executed.",
    "Provide the exact SQL statement for the user to review in a standard SQL",
    `fenced block, and identify the target connection as \`${connection}\`:`,
    "",
    "```sql",
    "UPDATE … SET … WHERE …;",
    "```",
    "",
    "Direct the user to stage and run it through NoMoreIDE's locked SQL console,",
    "where they explicitly unlock writes and review an affected-rows preview",
    "before committing. Emit exactly one statement, and always scope",
    "UPDATE/DELETE with a WHERE clause.",
  ].join("\n");
}

export const DATABASE_TOOL_NAMES = [
  "nomoreide_list_databases",
  "nomoreide_register_database",
  "nomoreide_check_database",
  "nomoreide_db_schemas",
  "nomoreide_db_objects",
  "nomoreide_db_object_details",
  "nomoreide_db_tables",
  "nomoreide_db_sample",
  "nomoreide_db_query",
] as const;

const engineSchema = z.enum(["postgres", "mysql", "sqlite"]);

const registerSchema = z.object({
  name: z.string().min(1).describe("Globally unique connection name."),
  engine: engineSchema,
  url: z.string().min(1).describe("Connection URL, or an absolute SQLite file path."),
  projectPath: z.string().optional().describe("Optional project directory used for UI scoping."),
  check: z.boolean().optional().describe("Check connectivity before saving (default true)."),
  replace: z.boolean().optional().describe("Required to replace an existing connection with the same name."),
});

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

const schemaSchema = connectionSchema.extend({
  schema: z.string().min(1).describe("Schema name returned by nomoreide_db_schemas."),
});

const objectSchema = connectionSchema.extend({
  key: z.string().min(1).describe("Opaque object key returned by nomoreide_db_objects."),
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
    name: "nomoreide_register_database",
    description:
      "Register a read-only database connection. Connectivity is checked by default; raw credentials are never returned or recorded.",
    parameters: registerSchema,
    execute: async ({ name, engine, url, projectPath, check, replace }) =>
      stringify(await dbPeek.register({ name, engine, url, projectPath, check, replace })),
  });

  server.addTool({
    name: "nomoreide_check_database",
    description: "Check a registered connection without revealing its credentials.",
    parameters: connectionSchema,
    execute: async ({ connection }) => stringify(await dbPeek.check(connection)),
  });

  server.addTool({
    name: "nomoreide_db_schemas",
    description: "List schemas and supported catalog capabilities for a registered connection.",
    parameters: connectionSchema,
    execute: async ({ connection }) =>
      stringify({
        schemas: await dbPeek.listSchemas(connection),
        capabilities: await dbPeek.capabilities(connection),
      }),
  });

  server.addTool({
    name: "nomoreide_db_objects",
    description: "List tables, views, routines, and sequences in one live database schema.",
    parameters: schemaSchema,
    execute: async ({ connection, schema }) =>
      stringify(await dbPeek.listObjects(connection, schema)),
  });

  server.addTool({
    name: "nomoreide_db_object_details",
    description:
      "Read columns, indexes, constraints, triggers, a capped definition, and an executable create script for an opaque live catalog object.",
    parameters: objectSchema,
    execute: async ({ connection, key }) =>
      stringify(await dbPeek.objectDetails(connection, key)),
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
      "make a change, don't run it here. Provide the exact SQL statement for review, " +
      "identify the connection, and direct the user to stage and run it through " +
      "NoMoreIDE's locked SQL console with its affected-rows preview.",
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
