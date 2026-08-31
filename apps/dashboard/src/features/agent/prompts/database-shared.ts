import type { ColumnInfo } from "@/lib/api";

/**
 * Shared structural bits for the database prompts. The per-surface *wording*
 * stays in each prompt file (so it's easy to tweak in one place); only the
 * mechanical formatting that would otherwise be copy-pasted lives here.
 */

/** One bullet per column: `- name: type (PK) NOT NULL`. */
export function columnSchemaLines(columns: ColumnInfo[]): string {
  return columns
    .map(
      (col) =>
        `- ${col.name}: ${col.dataType}${col.primaryKey ? " (PK)" : ""}${
          col.nullable ? "" : " NOT NULL"
        }`,
    )
    .join("\n");
}

/** A `## Table schema` block, or "" when we don't have the columns yet. */
export function schemaSection(columns?: ColumnInfo[]): string {
  if (!columns?.length) return "";
  return ["## Table schema", columnSchemaLines(columns), ""].join("\n");
}

/**
 * Trailer for prompts that are *drafted* into the dock input rather than
 * auto-sent — it cues the user to type their own prompt before sending.
 */
export const PROMPT_TRAILER = "Your prompt: ";
