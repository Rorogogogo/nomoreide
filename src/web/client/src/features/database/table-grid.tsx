import { Braces, Database, FileSpreadsheet, KeyRound } from "lucide-react";
import { useAgentDock } from "@/features/agent/chat/agent-context";
import { AiSpark } from "@/features/agent/ai-spark";
import { buildRowPrompt } from "@/features/agent/prompts";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { useToasts } from "@/components/ui/toast";
import { type RowSample } from "@/lib/api";

export function TableGrid({
  connection,
  sample,
}: {
  connection: string;
  sample: RowSample;
}) {
  const { sendToAgent } = useAgentDock();
  const { success: showSuccess, error: showError } = useToasts();
  const columnNames = sample.columns.map((col) => col.name);

  // Send the row straight to the dock and stream the answer.
  function askRow(row: Record<string, unknown>) {
    sendToAgent({
      prompt: buildRowPrompt(connection, sample.engine, sample.table, sample.columns, row),
      source: { type: "database-row", label: `${sample.table} row` },
      mode: "send",
    });
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(`Copied ${what}.`);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function toCsv(row: Record<string, unknown>) {
    const esc = (value: unknown) => {
      const cell = formatCell(value);
      return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
    };
    return `${columnNames.join(",")}\n${columnNames.map((name) => esc(row[name])).join(",")}`;
  }

  function toSqlInsert(row: Record<string, unknown>) {
    const literal = (value: unknown) => {
      if (value === null || value === undefined) return "NULL";
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      const text = typeof value === "object" ? JSON.stringify(value) : String(value);
      return `'${text.replace(/'/g, "''")}'`;
    };
    const values = columnNames.map((name) => literal(row[name])).join(", ");
    return `INSERT INTO ${sample.table} (${columnNames.join(", ")}) VALUES (${values});`;
  }

  if (sample.columns.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This table has no columns.
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {/* w-max lets wide tables exceed the viewport so the container scrolls
          horizontally; min-w-full keeps narrow tables filling the space. */}
      <table className="w-max min-w-full border-collapse text-left font-mono text-[11px]">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border">
            {sample.columns.map((col) => (
              <th
                key={col.name}
                className="whitespace-nowrap px-3 py-2 font-semibold text-foreground"
              >
                <span className="flex items-center gap-1">
                  {col.primaryKey ? (
                    <KeyRound className="size-3 text-amber-500" />
                  ) : null}
                  {col.name}
                </span>
                <span className="block text-[10px] font-normal text-muted-foreground">
                  {col.dataType}
                </span>
              </th>
            ))}
            {/* Trailing action column — AI spark + row actions on the right. */}
            <th className="w-16 px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {sample.rows.map((row, index) => (
            // Sampled rows have no stable key; index is fine for a read-only view.
            // biome-ignore lint/suspicious/noArrayIndexKey: read-only sample
            <tr key={index} className="group border-b border-border/60 hover:bg-muted/40">
              {sample.columns.map((col) => (
                <td
                  key={col.name}
                  className="max-w-[320px] truncate px-3 py-1 align-top text-muted-foreground"
                  title={formatCell(row[col.name])}
                >
                  {formatCell(row[col.name])}
                </td>
              ))}
              <td className="px-2 py-1 align-top">
                <div className="flex items-center justify-end gap-0.5">
                  <AiSpark label="Ask AI about this row" onAsk={() => askRow(row)} />
                  <OverflowMenu
                    label="Row actions"
                    items={[
                      {
                        label: "Copy as JSON",
                        icon: <Braces className="size-3.5" />,
                        onSelect: () => void copy(JSON.stringify(row, null, 2), "row as JSON"),
                      },
                      {
                        label: "Copy as CSV",
                        icon: <FileSpreadsheet className="size-3.5" />,
                        onSelect: () => void copy(toCsv(row), "row as CSV"),
                      },
                      {
                        label: "Copy as SQL INSERT",
                        icon: <Database className="size-3.5" />,
                        onSelect: () => void copy(toSqlInsert(row), "INSERT statement"),
                      },
                    ]}
                  />
                </div>
              </td>
            </tr>
          ))}
          {sample.rows.length === 0 ? (
            <tr>
              <td
                colSpan={sample.columns.length + 1}
                className="px-3 py-6 text-center text-muted-foreground"
              >
                No rows.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
