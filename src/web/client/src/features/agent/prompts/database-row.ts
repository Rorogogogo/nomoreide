import type { ColumnInfo, DatabaseEngine, TableRef } from "@/lib/api";
import { PROMPT_TRAILER, schemaSection } from "./database-shared";

/**
 * Build the "ask about this row" prefill. Drafted into the dock input (not
 * auto-sent), so it ends on an open `Your prompt:` line — same as
 * {@link buildTablePrompt} — to cue the user to type their own question.
 */
export function buildRowPrompt(
  connection: string,
  engine: DatabaseEngine,
  table: TableRef,
  columns: ColumnInfo[],
  row: Record<string, unknown>,
): string {
  return [
    `I'm looking at a row in my ${engine} database (connection "${connection}", table \`${table.qualifiedName}\`).`,
    "",
    schemaSection(columns),
    "## Row",
    "```json",
    JSON.stringify(row, null, 2),
    "```",
    "",
    PROMPT_TRAILER,
  ].join("\n");
}
