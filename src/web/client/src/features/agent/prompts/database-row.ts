import type { ColumnInfo, DatabaseEngine, TableRef } from "@/lib/api";

/** Build the "explain this row to the agent" prompt from already-fetched data. */
export function buildRowPrompt(
  connection: string,
  engine: DatabaseEngine,
  table: TableRef,
  columns: ColumnInfo[],
  row: Record<string, unknown>,
): string {
  const schemaLines = columns
    .map(
      (col) =>
        `- ${col.name}: ${col.dataType}${col.primaryKey ? " (PK)" : ""}${
          col.nullable ? "" : " NOT NULL"
        }`,
    )
    .join("\n");
  return [
    `I'm looking at a row in my ${engine} database (connection "${connection}", table \`${table.qualifiedName}\`).`,
    "",
    "## Table schema",
    schemaLines,
    "",
    "## Row",
    "```json",
    JSON.stringify(row, null, 2),
    "```",
    "",
    "Explain what this row represents and anything notable about its values.",
  ].join("\n");
}
