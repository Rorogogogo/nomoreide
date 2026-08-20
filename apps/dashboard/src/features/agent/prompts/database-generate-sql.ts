import type { DatabaseEngine, TableRef } from "@/lib/api";

/**
 * Build the "write me this query" prompt for the SQL console's Generate-with-AI
 * field. Unlike {@link buildTablePrompt} this is auto-sent and parsed back: the
 * console drops the returned statement straight into the editor, so the prompt
 * pins the reply to a single fenced `sql` block with no prose around it.
 *
 * A locked connection asks for read-only SELECTs only — generation must never
 * hand the user a destructive statement they didn't unlock for.
 */
export function buildGenerateSqlPrompt(
  connection: string,
  intent: string,
  options: { engine?: DatabaseEngine; tables?: TableRef[]; unlocked?: boolean },
): string {
  const dialect = options.engine ? `${options.engine} ` : "";
  const tableNames = (options.tables ?? [])
    .map((table) => table.qualifiedName)
    .filter(Boolean);

  const lines = [
    `Write one ${dialect}SQL statement for the database connection "${connection}".`,
    "",
    "What it should do:",
    intent.trim(),
    "",
  ];

  if (tableNames.length) {
    lines.push("Tables in this database:");
    lines.push(tableNames.map((name) => `- ${name}`).join("\n"));
    lines.push(
      "Inspect a table's columns with the database tools if you need its exact schema.",
    );
  } else {
    lines.push(
      "Use the database tools to inspect the available tables and columns before writing the query.",
    );
  }
  lines.push("");

  lines.push("Rules:");
  if (options.unlocked) {
    lines.push(
      "- This connection is unlocked for writes, so INSERT/UPDATE/DELETE/DDL are allowed if that's what was asked for.",
    );
  } else {
    lines.push(
      "- This connection is read-only. Return a SELECT (or other read) statement only — never a write.",
    );
  }
  lines.push("- Return exactly one statement.");
  lines.push(
    "- Output ONLY the statement inside a single ```sql code fence — no explanation before or after.",
  );

  return lines.join("\n");
}
