import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Braces,
  Database,
  FileSpreadsheet,
  KeyRound,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToasts } from "@/components/ui/toast";
import { AiContextTarget } from "@/features/agent/context-menu/ai-context-menu";
import { buildRowPrompt } from "@/features/agent/prompts";
import {
  deleteDatabaseRows,
  type DatabaseRowKeyValue,
  type RowBrowseQuery,
  type RowSample,
  type WriteOutcome,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatCell, isSafeKeyValue, toCsv, toSqlInsert } from "./table-grid-format";
export { formatCell } from "./table-grid-format";
import { UnlockDialog } from "./sql-write-dialogs";
import { useWriteAccess } from "./use-databases";

type CopyFormat = "json" | "csv" | "insert";
const NOOP = () => {};

interface PendingDelete {
  keys: Array<Record<string, DatabaseRowKeyValue>>;
  preview: WriteOutcome;
}

export function TableGrid({
  canDelete = true,
  connection,
  sample,
  objectKey = sample.table.qualifiedName,
  onDeleted = NOOP,
  onSortChange = NOOP,
  onWriteAccessChange = NOOP,
  sort,
  writeUnlocked = false,
}: {
  canDelete?: boolean;
  connection: string;
  objectKey?: string;
  onDeleted?: () => void | Promise<void>;
  onWriteAccessChange?: () => void;
  sample: RowSample;
  sort?: RowBrowseQuery["sort"];
  onSortChange?: (sort: RowBrowseQuery["sort"]) => void;
  writeUnlocked?: boolean;
}) {
  const t = useT();
  const { success: showSuccess, error: showError } = useToasts();
  const access = useWriteAccess(connection, onWriteAccessChange);
  const [selection, setSelectionState] = useState<Set<number>>(new Set());
  const selectionRef = useRef(selection);
  const anchorRef = useRef<number | null>(null);
  const [showUnlock, setShowUnlock] = useState(false);
  const [locallyUnlocked, setLocallyUnlocked] = useState(writeUnlocked);
  const deleteAfterUnlockRef = useRef(false);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const columnNames = sample.columns.map((column) => column.name);
  const primaryKeys = sample.columns.filter((column) => column.primaryKey).map((column) => column.name);
  const maxDeleteRows = Math.min(100, Math.floor(500 / Math.max(primaryKeys.length, 1)));
  const deletionAvailable =
    canDelete &&
    primaryKeys.length > 0 &&
    sample.rows.every((row) => primaryKeys.every((name) => isSafeKeyValue(row[name])));

  function setSelection(next: Set<number>) {
    selectionRef.current = next;
    setSelectionState(next);
  }

  useEffect(() => {
    setSelection(new Set());
    anchorRef.current = null;
    setPendingDelete(null);
  }, [objectKey, sample.offset, sample.rows]);

  useEffect(() => setLocallyUnlocked(writeUnlocked), [writeUnlocked]);

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(t("database.grid.copiedWhat", { what }));
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function rowsForAction(fallbackIndex?: number) {
    const selected = [...selectionRef.current].sort((a, b) => a - b);
    const indexes = selected.length > 0 ? selected : fallbackIndex === undefined ? [] : [fallbackIndex];
    return indexes.map((index) => sample.rows[index]).filter(Boolean);
  }

  function copyRows(format: CopyFormat, fallbackIndex?: number) {
    const rows = rowsForAction(fallbackIndex);
    if (rows.length === 0) return;
    if (format === "json") {
      const value = rows.length === 1 ? rows[0] : rows;
      void copy(JSON.stringify(value, null, 2), t("database.grid.rowsAsJson", { count: rows.length }));
      return;
    }
    if (format === "csv") {
      void copy(toCsv(rows, columnNames), t("database.grid.rowsAsCsv", { count: rows.length }));
      return;
    }
    void copy(
      rows.map((row) => toSqlInsert(row, sample)).join("\n"),
      t("database.grid.insertStatements", { count: rows.length }),
    );
  }

  function toggleRow(index: number, options: { range?: boolean; additive?: boolean } = {}) {
    if (options.range && anchorRef.current !== null) {
      const from = Math.min(anchorRef.current, index);
      const to = Math.max(anchorRef.current, index);
      const next = options.additive ? new Set(selectionRef.current) : new Set<number>();
      for (let cursor = from; cursor <= to; cursor += 1) next.add(cursor);
      setSelection(next);
      return;
    }
    const next = options.additive ? new Set(selectionRef.current) : new Set<number>();
    if (options.additive && next.has(index)) next.delete(index);
    else next.add(index);
    anchorRef.current = index;
    setSelection(next);
  }

  function selectForContextMenu(index: number) {
    if (selectionRef.current.has(index)) return;
    anchorRef.current = index;
    setSelection(new Set([index]));
  }

  function selectedKeys(): Array<Record<string, DatabaseRowKeyValue>> | null {
    const rows = rowsForAction();
    if (!deletionAvailable || rows.length === 0 || rows.length > maxDeleteRows) return null;
    return rows.map((row) =>
      Object.fromEntries(primaryKeys.map((name) => [name, row[name] as DatabaseRowKeyValue])),
    );
  }

  async function previewDelete() {
    const keys = selectedKeys();
    if (!keys) return;
    setPreviewing(true);
    try {
      const preview = await deleteDatabaseRows(connection, {
        objectKey,
        keys,
        mode: "preview",
      });
      if (preview.affectedRows !== keys.length) {
        showError(t("database.grid.deletePreviewMismatch", {
          affected: preview.affectedRows ?? 0,
          selected: keys.length,
        }));
        await onDeleted();
        return;
      }
      setPendingDelete({ keys, preview });
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPreviewing(false);
    }
  }

  function requestDelete() {
    if (!selectedKeys()) return;
    if (!locallyUnlocked) {
      deleteAfterUnlockRef.current = true;
      setShowUnlock(true);
      return;
    }
    void previewDelete();
  }

  async function commitDelete() {
    if (!pendingDelete) return;
    setCommitting(true);
    try {
      const result = await deleteDatabaseRows(connection, {
        objectKey,
        keys: pendingDelete.keys,
        mode: "commit",
        expectedAffectedRows: pendingDelete.preview.affectedRows,
      });
      const affected = result.affectedRows ?? pendingDelete.keys.length;
      setPendingDelete(null);
      setSelection(new Set());
      showSuccess(t("database.grid.deletedRows", { count: affected }));
      await onDeleted();
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCommitting(false);
    }
  }

  if (sample.columns.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">{t("database.grid.noColumnsTable")}</div>;
  }

  const allSelected = sample.rows.length > 0 && selection.size === sample.rows.length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {selection.size > 0 ? (
        <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-muted/20 px-2 py-1">
          <span className="mr-1 text-[10px] tabular-nums text-muted-foreground">
            {t("database.grid.selectedRows", { count: selection.size })}
          </span>
          <BulkAction icon={<Braces />} label={t("database.grid.copyJson")} onClick={() => copyRows("json")} />
          <BulkAction icon={<FileSpreadsheet />} label={t("database.grid.copyCsv")} onClick={() => copyRows("csv")} />
          <BulkAction icon={<Database />} label={t("database.grid.copySqlInsert")} onClick={() => copyRows("insert")} />
          {deletionAvailable && selection.size <= maxDeleteRows ? (
            <Button
              className="ml-auto h-6 gap-1 px-1.5 text-[10px]"
              disabled={previewing}
              onClick={requestDelete}
              size="sm"
              type="button"
              variant="ghost"
            >
              {previewing ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> : <Trash2 className="size-3 text-destructive" />}
              <span className="text-destructive">{t("common.delete")}</span>
            </Button>
          ) : null}
          <Button
            aria-label={t("database.grid.clearSelection")}
            className={cn("h-6 w-6 p-0", deletionAvailable && "ml-0")}
            onClick={() => setSelection(new Set())}
            size="sm"
            title={t("database.grid.clearSelection")}
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-3" />
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="code-font-size w-max min-w-full border-collapse text-left font-mono">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border">
              <th className="sticky left-0 z-20 w-9 border-r border-border bg-card px-2 py-2 text-center">
                <input
                  aria-label={t("database.grid.selectPage")}
                  checked={allSelected}
                  className="size-3.5 accent-foreground"
                  onChange={() => {
                    setSelection(allSelected ? new Set() : new Set(sample.rows.map((_, index) => index)));
                    anchorRef.current = null;
                  }}
                  type="checkbox"
                />
              </th>
              {sample.columns.map((column) => (
                <th
                  aria-sort={sort?.column === column.name ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                  className="whitespace-nowrap px-3 py-2 font-semibold text-foreground"
                  key={column.name}
                >
                  <button
                    aria-label={t("database.grid.sortBy", { column: column.name })}
                    className="group flex items-center gap-1 rounded-sm hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onSortChange(
                      sort?.column !== column.name
                        ? { column: column.name, direction: "asc" }
                        : sort.direction === "asc"
                          ? { column: column.name, direction: "desc" }
                          : undefined,
                    )}
                    title={t("database.grid.sortBy", { column: column.name })}
                    type="button"
                  >
                    {column.primaryKey ? <KeyRound aria-hidden="true" className="size-3 text-amber-500" /> : null}
                    {column.name}
                    {sort?.column === column.name
                      ? sort.direction === "asc"
                        ? <ArrowUp aria-hidden="true" className="size-3" />
                        : <ArrowDown aria-hidden="true" className="size-3" />
                      : <ArrowUpDown aria-hidden="true" className="size-3 text-muted-foreground/50 group-hover:text-muted-foreground" />}
                  </button>
                  <span className="block font-normal text-muted-foreground">{column.dataType}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.rows.map((row, index) => {
              const selected = selection.has(index);
              return (
                <AiContextTarget
                  // biome-ignore lint/suspicious/noArrayIndexKey: sampled rows have no stable key
                  key={index}
                  target={{
                    label: t("database.grid.rowSource", { table: sample.table.name }),
                    actions: [
                      {
                        id: "copy-json",
                        label: t("database.grid.copyJson"),
                        icon: <Braces aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
                        onSelect: () => copyRows("json", index),
                      },
                      {
                        id: "copy-csv",
                        label: t("database.grid.copyCsv"),
                        icon: <FileSpreadsheet aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
                        onSelect: () => copyRows("csv", index),
                      },
                      {
                        id: "copy-insert",
                        label: t("database.grid.copySqlInsert"),
                        icon: <Database aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
                        onSelect: () => copyRows("insert", index),
                      },
                      ...(deletionAvailable && selection.size <= maxDeleteRows
                        ? [{
                            destructive: true,
                            icon: <Trash2 aria-hidden="true" className="mr-2 size-4" />,
                            id: "delete",
                            label: t("database.grid.deleteSelected"),
                            onSelect: requestDelete,
                          }]
                        : []),
                    ],
                    intents: [{
                      id: "ask-row",
                      label: t("database.grid.askAiRow"),
                      resolvePrompt: () => buildRowPrompt(connection, sample.engine, sample.table, sample.columns, row),
                      source: {
                        type: "database-row",
                        label: t("database.grid.rowSource", { table: sample.table.name }),
                      },
                    }],
                  }}
                >
                  <tr
                    aria-selected={selected}
                    className={cn(
                      "group cursor-default border-b border-border/60 transition-colors hover:bg-muted/20",
                      selected && "bg-muted/45 text-foreground",
                    )}
                    onClick={(event) => toggleRow(index, {
                      additive: event.metaKey || event.ctrlKey,
                      range: event.shiftKey,
                    })}
                    onContextMenu={() => selectForContextMenu(index)}
                  >
                    <td className={cn(
                      "sticky left-0 z-[1] border-r border-border/60 px-2 py-1 text-center",
                      selected ? "bg-muted" : "bg-card group-hover:bg-muted/20",
                    )}>
                      <input
                        aria-label={t("database.grid.selectRow", { row: index + 1 })}
                        checked={selected}
                        className="size-3.5 accent-foreground"
                        onChange={(event) => toggleRow(index, {
                          additive: true,
                          range: event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey,
                        })}
                        onClick={(event) => event.stopPropagation()}
                        type="checkbox"
                      />
                    </td>
                    {sample.columns.map((column) => (
                      <td
                        key={column.name}
                        className="max-w-[320px] truncate px-3 py-1 align-top text-muted-foreground"
                        title={formatCell(row[column.name])}
                      >
                        {formatCell(row[column.name])}
                      </td>
                    ))}
                  </tr>
                </AiContextTarget>
              );
            })}
            {sample.rows.length === 0 ? (
              <tr>
                <td colSpan={sample.columns.length + 1} className="px-3 py-6 text-center text-muted-foreground">
                  {t("database.grid.noRows")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {showUnlock ? (
        <UnlockDialog
          busy={access.updating}
          connection={connection}
          onClose={() => {
            deleteAfterUnlockRef.current = false;
            setShowUnlock(false);
          }}
          onConfirm={async () => {
            try {
              await access.setUnlocked(true);
              setLocallyUnlocked(true);
              setShowUnlock(false);
              if (deleteAfterUnlockRef.current) await previewDelete();
            } catch (caught) {
              showError(caught instanceof Error ? caught.message : String(caught));
            } finally {
              deleteAfterUnlockRef.current = false;
            }
          }}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={committing ? t("database.grid.deleting") : t("database.grid.confirmDelete")}
          icon={<Trash2 className="text-destructive" />}
          loading={committing}
          message={
            <div className="space-y-2">
              <p>
                {t("database.grid.deleteWarning", {
                  affected: pendingDelete.preview.affectedRows ?? 0,
                  selected: pendingDelete.keys.length,
                })}
              </p>
              <p>{t("database.grid.deleteCascadeWarning")}</p>
            </div>
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void commitDelete()}
          title={t("database.grid.deleteTitle", { count: pendingDelete.keys.length })}
          tone="danger"
        />
      ) : null}
    </div>
  );
}

function BulkAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Button className="h-6 gap-1 px-1.5 text-[10px]" onClick={onClick} size="sm" type="button" variant="ghost">
      <span aria-hidden="true" className="[&_svg]:size-3">{icon}</span>
      {label}
    </Button>
  );
}
