import type { DatabaseEngine } from "@/lib/api";

/**
 * Build the "this query failed — what's wrong?" prompt for the SQL console's
 * Debug button. Unlike {@link buildGenerateSqlPrompt} this is a conversational
 * ask, not a parsed reply: it hands the agent the exact statement and the engine
 * error so it can explain the cause and suggest a corrected query in the dock.
 */
export function buildDebugSqlPrompt(
  connection: string,
  engine: DatabaseEngine | undefined,
  sql: string,
  error: string,
): string {
  const dialect = engine ? `${engine} ` : "";
  return [
    `This ${dialect}query against the database connection "${connection}" failed.`,
    "",
    "Statement:",
    "```sql",
    sql.trim(),
    "```",
    "",
    "Error returned by the database:",
    "```",
    error.trim(),
    "```",
    "",
    "Explain what's wrong and why, then give a corrected statement in a ```sql code fence.",
    "Use the database tools to check the actual schema if the fix depends on it.",
  ].join("\n");
}
