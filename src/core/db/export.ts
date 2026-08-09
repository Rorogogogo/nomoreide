import { isSensitiveDatabaseColumn, maskDatabaseRow } from "./data-masking.js";
import type { ColumnInfo } from "./driver.js";

export type DatabaseExportFormat = "csv" | "json";

export interface DatabaseExportWriter {
  write(chunk: string): Promise<void>;
}

export interface DatabaseExportProgress {
  rowsWritten: number;
  bytesWritten: number;
}

export interface DatabaseExportSummary extends DatabaseExportProgress {
  maskedColumns: string[];
}

export async function writeDatabaseExport(
  writer: DatabaseExportWriter,
  format: DatabaseExportFormat,
  columns: ColumnInfo[],
  batches: AsyncIterable<Array<Record<string, unknown>>>,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DatabaseExportProgress) => void;
  } = {},
): Promise<DatabaseExportSummary> {
  const names = columns.map((column) => column.name);
  const maskedColumns = names.filter(isSensitiveDatabaseColumn);
  let rowsWritten = 0;
  let bytesWritten = 0;
  let firstJsonRow = true;

  async function write(chunk: string) {
    throwIfAborted(options.signal);
    await writer.write(chunk);
    bytesWritten += Buffer.byteLength(chunk);
  }

  if (format === "csv") await write(`${names.map(csvCell).join(",")}\r\n`);
  else await write("[");

  for await (const batch of batches) {
    for (const rawRow of batch) {
      throwIfAborted(options.signal);
      const row = maskDatabaseRow(rawRow);
      if (format === "csv") {
        await write(`${names.map((name) => csvCell(row[name])).join(",")}\r\n`);
      } else {
        const normalized = Object.fromEntries(
          names.map((name) => [name, stableValue(row[name] ?? null)]),
        );
        await write(`${firstJsonRow ? "" : ","}${JSON.stringify(normalized)}`);
        firstJsonRow = false;
      }
      rowsWritten += 1;
      options.onProgress?.({ rowsWritten, bytesWritten });
    }
  }
  if (format === "json") await write("]\n");

  return { rowsWritten, bytesWritten, maskedColumns };
}

export function csvCell(value: unknown): string {
  let text = exportScalar(value);
  if (typeof value === "string" && /^[\t\r]|^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return stableStringify(value);
  return String(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Database export cancelled", "AbortError");
}
