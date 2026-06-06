import type { ColumnInfo, DatabaseEngine, TableRef } from "@/lib/api";
import { PROMPT_TRAILER, schemaSection } from "./database-shared";

/**
 * Build the "ask about this table" prefill. Drafted into the input (not
 * auto-sent) so the user appends their own question. We hand the agent the
 * table's identity and — when we already have it — its column schema; either
 * way the agent can sample rows itself via the db tools.
 */
export function buildTablePrompt(
  connection: string,
  table: TableRef,
  options?: { engine?: DatabaseEngine; columns?: ColumnInfo[] },
): string {
  const where = options?.engine
    ? `my ${options.engine} database (connection "${connection}")`
    : `my database (connection "${connection}")`;
  const lines = [
    `I'm looking at the table \`${table.qualifiedName}\` in ${where}.`,
    "",
  ];
  const schema = schemaSection(options?.columns);
  if (schema) lines.push(schema);
  lines.push(PROMPT_TRAILER);
  return lines.join("\n");
}
