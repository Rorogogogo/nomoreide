const SENSITIVE_COLUMN =
  /(^|_)(password|passwd|pwd|secret|token|api_?key|access_?key|private_?key|credential|authorization|cookie)(_|$)/i;

export function isSensitiveDatabaseColumn(name: string): boolean {
  return SENSITIVE_COLUMN.test(name);
}

export function maskDatabaseRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      isSensitiveDatabaseColumn(column) && value !== null ? "••••" : value,
    ]),
  );
}

export function maskDatabaseRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map(maskDatabaseRow);
}
