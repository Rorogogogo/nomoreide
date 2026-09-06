import type { DatabaseRowKeyValue, RowSample } from "@/lib/api";

/**
 * Turning a result row into text: what a cell reads as, and the CSV / INSERT a
 * copy produces.
 *
 * `quoteIdentifier` and `sqlLiteral` exist because the generated INSERT is
 * shown to a human and may be pasted into a client — the values come from the
 * database, but the escaping still has to be right for the engine in hand.
 */

export function isSafeKeyValue(value: unknown): value is DatabaseRowKeyValue {
  return (
    value !== "••••" &&
    (typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" &&
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))))
  );
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]) {
  const escapeCell = (value: unknown) => {
    const cell = formatCell(value);
    return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((name) => escapeCell(row[name])).join(","))].join("\n");
}

export function toSqlInsert(row: Record<string, unknown>, sample: RowSample) {
  const columns = sample.columns.map((column) => quoteIdentifier(column.name, sample.engine));
  const values = sample.columns.map((column) => sqlLiteral(row[column.name])).join(", ");
  const table = sample.table.schema
    ? `${quoteIdentifier(sample.table.schema, sample.engine)}.${quoteIdentifier(sample.table.name, sample.engine)}`
    : quoteIdentifier(sample.table.name, sample.engine);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values});`;
}

export function quoteIdentifier(value: string, engine: RowSample["engine"]) {
  return engine === "mysql"
    ? `\`${value.replace(/`/g, "``")}\``
    : `"${value.replace(/"/g, '""')}"`;
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
