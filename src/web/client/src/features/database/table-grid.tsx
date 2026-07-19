import { Braces, Database, FileSpreadsheet, KeyRound } from "lucide-react";
import { useAgentDock } from "@/features/agent/chat/agent-context";
import { AiSpark } from "@/features/agent/ai-spark";
import { buildRowPrompt } from "@/features/agent/prompts";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { type RowSample } from "@/lib/api";

export function TableGrid({
  connection,
  sample,
}: {
  connection: string;
  sample: RowSample;
}) {
  const t = useT();
  const { sendToAgent } = useAgentDock();
  const { success: showSuccess, error: showError } = useToasts();
  const columnNames = sample.columns.map((col) => col.name);

  // Draft the row into the dock input — the user reviews and sends it, the same
  // as the table-level "Ask AI" buttons. Nothing auto-runs.
  function askRow(row: Record<string, unknown>) {
    sendToAgent({
      prompt: buildRowPrompt(connection, sample.engine, sample.table, sample.columns, row),
      source: { type: "database-row", label: t("database.grid.rowSource", { table: sample.table.name }) },
      mode: "draft",
    });
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(t("database.grid.copiedWhat", { what }));
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
        {t("database.grid.noColumnsTable")}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {/* w-max lets wide tables exceed the viewport so the container scrolls
          horizontally; min-w-full keeps narrow tables filling the space. */}
      <table className="code-font-size w-max min-w-full border-collapse text-left font-mono">
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
                <span className="block font-normal text-muted-foreground">
                  {col.dataType}
                </span>
              </th>
            ))}
            {/* Trailing action column — docked to the right edge so the AI
                spark + row actions stay visible without scrolling wide tables. */}
            <th className="sticky right-0 z-20 w-16 border-l border-border bg-card px-2 py-2" />
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
              {/* Opaque bg-card base stays put so scrolled cells never bleed
                  through; the hover tint is a pseudo-overlay, not a background
                  swap, so it can't reintroduce transparency. */}
              <td className="sticky right-0 z-[1] border-l border-border/60 bg-card px-2 py-1 align-top before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40 before:opacity-0 group-hover:before:opacity-100">
                <div className="relative z-[1] flex items-center justify-end gap-0.5">
                  <AiSpark label={t("database.grid.askAiRow")} onAsk={() => askRow(row)} />
                  <OverflowMenu
                    label={t("database.grid.rowActions")}
                    items={[
                      {
                        label: t("database.grid.copyJson"),
                        icon: <Braces className="size-3.5" />,
                        onSelect: () =>
                          void copy(JSON.stringify(row, null, 2), t("database.grid.rowAsJson")),
                      },
                      {
                        label: t("database.grid.copyCsv"),
                        icon: <FileSpreadsheet className="size-3.5" />,
                        onSelect: () => void copy(toCsv(row), t("database.grid.rowAsCsv")),
                      },
                      {
                        label: t("database.grid.copySqlInsert"),
                        icon: <Database className="size-3.5" />,
                        onSelect: () =>
                          void copy(toSqlInsert(row), t("database.grid.insertStatement")),
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
                {t("database.grid.noRows")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
