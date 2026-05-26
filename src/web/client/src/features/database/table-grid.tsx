import { Bot, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { buildRowPrompt, type RowSample } from "@/lib/api";

export function TableGrid({
  connection,
  sample,
}: {
  connection: string;
  sample: RowSample;
}) {
  const { success: showSuccess, error: showError } = useToasts();

  async function explainRow(row: Record<string, unknown>) {
    try {
      const prompt = buildRowPrompt(
        connection,
        sample.engine,
        sample.table,
        sample.columns,
        row,
      );
      await navigator.clipboard.writeText(prompt);
      showSuccess("Copied row + schema prompt to clipboard.");
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
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
            <th className="w-10 px-2 py-2" />
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
          </tr>
        </thead>
        <tbody>
          {sample.rows.map((row, index) => (
            // Sampled rows have no stable key; index is fine for a read-only view.
            // biome-ignore lint/suspicious/noArrayIndexKey: read-only sample
            <tr key={index} className="group border-b border-border/60 hover:bg-muted/40">
              <td className="px-2 py-1 align-top">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 opacity-0 transition-opacity group-hover:opacity-100"
                  title="Explain this row to the agent"
                  onClick={() => void explainRow(row)}
                  type="button"
                >
                  <Bot className="size-3.5" />
                </Button>
              </td>
              {sample.columns.map((col) => (
                <td
                  key={col.name}
                  className="max-w-[320px] truncate px-3 py-1 align-top text-muted-foreground"
                  title={formatCell(row[col.name])}
                >
                  {formatCell(row[col.name])}
                </td>
              ))}
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
