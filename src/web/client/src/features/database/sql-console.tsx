import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Lock,
  LockOpen,
  Play,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOperations } from "@/components/operations/operation-context";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";
import type { ColumnInfo, DatabaseEngine } from "@/lib/api";
import { AgentMark } from "../agent/ai-spark";
import { AgentWaveLoader } from "../agent/agent-wave-loader";
import {
  AiContextTarget,
  type AiContextTargetDescriptor,
} from "../agent/context-menu/ai-context-menu";
import { buildDebugSqlPrompt } from "../agent/prompts";
import {
  databaseLimitOptions,
  isReadStatement,
  useSqlQuery,
  useSqlWrite,
  useWriteAccess,
} from "./use-databases";
import { useSqlGenerate } from "./use-sql-generate";
import { formatCell } from "./table-grid";
import { SqlQueryTabs } from "./saved-query-controls";
import { UnlockDialog, WritePreviewDialog } from "./sql-write-dialogs";

export interface SqlEditorAction {
  connection: string;
  mode: "insert" | "statement";
  nonce: number;
  sql: string;
}

/**
 * Ad-hoc SQL console. Locked by default: every statement runs read-only and
 * writes are rejected by the engine. When the user unlocks writes for this
 * connection, non-SELECT statements either use the configured preview approval
 * or commit directly. This surface is human-only — the agent never reaches the
 * write path, and the server-side connection lock remains authoritative.
 */
export function SqlConsole({
  connection,
  engine,
  editorAction,
  unlocked,
  seed,
  onWriteAccessChange,
  preferences = { confirmWrites: true, resultLimit: 100 },
}: {
  connection: string;
  engine?: DatabaseEngine;
  editorAction?: SqlEditorAction | null;
  unlocked: boolean;
  /** A statement staged from the dock agent, dropped into the editor (not run). */
  seed?: { sql: string; nonce: number } | null;
  onWriteAccessChange: () => void;
  preferences?: { confirmWrites: boolean; resultLimit: number };
}) {
  const t = useT();
  const { isPending, runOperation } = useOperations();
  const { success: showSuccess } = useToasts();
  const read = useSqlQuery(connection);
  const write = useSqlWrite(connection);
  const access = useWriteAccess(connection, onWriteAccessChange);
  const [sql, setSql] = usePersistentState(
    `database:sql-draft:v1:${connection}`,
    seed?.sql ?? "",
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [limit, setLimit] = useState<number>(() => preferences.resultLimit);
  const customizedLimitRef = useRef(false);

  useEffect(() => {
    if (!customizedLimitRef.current) setLimit(preferences.resultLimit);
  }, [preferences.resultLimit]);

  // Re-seed the editor when the dock stages another write into this same
  // connection (a new connection remounts via `key`, picking up the seed above).
  const seededNonce = seed?.nonce;
  useEffect(() => {
    if (seed) setSql(seed.sql);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seededNonce]);
  const editorActionNonce = editorAction?.nonce;
  useEffect(() => {
    if (!editorAction || editorAction.connection !== connection) return;
    const textarea = textareaRef.current;
    setSql((current) => {
      if (editorAction.mode === "statement") {
        return current.trim() ? `${current.trimEnd()}\n\n${editorAction.sql}` : editorAction.sql;
      }
      const start = textarea?.selectionStart ?? current.length;
      const end = textarea?.selectionEnd ?? start;
      return `${current.slice(0, start)}${editorAction.sql}${current.slice(end)}`;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [connection, editorActionNonce, setSql]);
  const [showUnlock, setShowUnlock] = useState(false);
  const generate = useSqlGenerate(connection, engine, unlocked, setSql);

  // A non-SELECT statement is a write regardless of the lock; whether we *run*
  // it (preview path) or block on the unlock gate depends on `unlocked`.
  const isWriteStatement = sql.trim().length > 0 && !isReadStatement(sql);
  const isWrite = unlocked && isWriteStatement;
  const needsUnlock = isWriteStatement && !unlocked;
  const running = read.running || write.previewing || write.committing;
  const writeOperationKey = `database:${connection}:write`;
  const writePending = isPending(writeOperationKey);
  function submit() {
    if (!sql.trim()) return;
    // Don't run a write read-only just to have the engine reject it — prompt the
    // user to unlock writes for this connection first.
    if (needsUnlock) {
      setShowUnlock(true);
      return;
    }
    if (isWrite) {
      read.reset();
      if (preferences.confirmWrites) void write.preview(sql);
      else void commitWrite(sql);
    } else {
      write.reset();
      void read.run(sql, limit);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  async function commitWrite(statement?: string) {
    const outcome = await runOperation(
      {
        key: writeOperationKey,
        label: t("database.sql.committingWrite", { connection }),
      },
      () => write.commit(statement),
    );
    if (outcome?.committed) {
      const affected = outcome.affectedRows ?? 0;
      showSuccess(t("database.sql.committed", { count: affected }));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SqlQueryTabs connection={connection} setSql={setSql} sql={sql} />
      <div className="shrink-0 border-b border-border p-2">
        <GenerateField generate={generate} />
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder={
            unlocked
              ? t("database.sql.placeholderUnlocked")
              : t("database.sql.placeholderLocked")
          }
          className="code-font-size h-24 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono outline-none focus:border-ring"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <LockControl
            unlocked={unlocked}
            updating={access.updating}
            onUnlock={() => setShowUnlock(true)}
            onLock={() => void access.setUnlocked(false)}
          />
          <div className="flex items-center gap-2">
            {!isWrite ? (
              <select
                aria-label={t("database.sql.maxRows")}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-[11px]"
                value={limit}
                onChange={(event) => {
                  customizedLimitRef.current = true;
                  setLimit(Number(event.target.value));
                }}
              >
                {databaseLimitOptions(preferences.resultLimit).map((size) => (
                  <option key={size} value={size}>
                    {t("database.sql.rowsOption", { size })}
                  </option>
                ))}
              </select>
            ) : null}
            <Button
              size="sm"
              className={cn("h-7 px-3", isWrite && "bg-amber-600 text-white hover:bg-amber-600/90")}
              onClick={submit}
              disabled={running || !sql.trim()}
              loading={isWrite && writePending}
              loadingLabel={t("database.sql.runWrite")}
              type="button"
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {isWrite
                ? preferences.confirmWrites
                  ? t("database.sql.previewWrite")
                  : t("database.sql.runWrite")
                : t("database.sql.run")}
            </Button>
          </div>
        </div>
      </div>

      <ResultArea
        read={read}
        write={write}
        debugTarget={(error) => ({
          label: t("database.sql.debugLabel"),
          intents: [{
            id: "debug-sql",
            label: t("database.sql.debugWithAi"),
            resolvePrompt: () => buildDebugSqlPrompt(connection, engine, sql, error),
            source: { type: "database-sql-debug", label: "Debug SQL" },
            agentLabel: t("database.sql.debugLabel"),
          }],
        })}
      />

      {showUnlock ? (
        <UnlockDialog
          connection={connection}
          busy={access.updating}
          onConfirm={async () => {
            await access.setUnlocked(true);
            setShowUnlock(false);
          }}
          onClose={() => setShowUnlock(false)}
        />
      ) : null}

      {write.pending ? (
        <WritePreviewDialog
          sql={write.pending.sql}
          preview={write.pending.preview}
          busy={write.committing}
          onConfirm={() => void commitWrite()}
          onClose={write.cancel}
        />
      ) : null}
    </div>
  );
}

/**
 * Natural-language → SQL field. The user describes what they want; the dock
 * agent writes the statement and it lands in the editor below, ready to review
 * and run. Generation respects the connection's lock (read-only stays SELECT).
 */
function GenerateField({ generate }: { generate: ReturnType<typeof useSqlGenerate> }) {
  const t = useT();
  const [intent, setIntent] = useState("");

  function submit() {
    const trimmed = intent.trim();
    if (!trimmed || generate.generating) return;
    void generate.generate(trimmed);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <AgentMark className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2" />
          <input
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={generate.generating}
            placeholder={t("database.sql.generatePlaceholder")}
            className={cn(
              "h-8 w-full rounded-md border border-border bg-background pl-7 text-[12px] outline-none focus:border-ring disabled:opacity-60",
              generate.generating ? "pr-44" : "pr-2",
            )}
          />
          {generate.generating ? (
            <AgentWaveLoader
              className="pointer-events-none absolute right-1 top-1/2 origin-right -translate-y-1/2 scale-[0.72]"
              label={t("database.sql.generating")}
            />
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            "h-8 px-3",
            generate.generating && "border-destructive/40 text-destructive hover:bg-destructive/10",
          )}
          onClick={generate.generating ? generate.cancel : submit}
          disabled={!generate.generating && !intent.trim()}
          type="button"
        >
          {generate.generating ? (
            <Square aria-hidden="true" className="size-3 fill-current" />
          ) : (
            <AgentMark className="size-3.5" />
          )}
          {generate.generating ? t("database.sql.stopGenerating") : t("database.sql.askAi")}
        </Button>
      </div>
      {generate.error ? (
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{generate.error}</p>
      ) : null}
    </div>
  );
}

function LockControl({
  unlocked,
  updating,
  onUnlock,
  onLock,
}: {
  unlocked: boolean;
  updating: boolean;
  onUnlock: () => void;
  onLock: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={unlocked ? onLock : onUnlock}
      disabled={updating}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
        unlocked
          ? "border-amber-500/50 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
      title={unlocked ? t("database.sql.writesUnlockedTitle") : t("database.sql.readOnlyTitle")}
    >
      {updating ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : unlocked ? (
        <LockOpen className="size-3.5" />
      ) : (
        <Lock className="size-3.5" />
      )}
      {unlocked ? t("database.sql.writesUnlocked") : t("database.sql.readOnly")}
    </button>
  );
}

/** Renders the active result: a committed write summary, query rows, or errors. */
function ResultArea({
  read,
  write,
  debugTarget,
}: {
  read: ReturnType<typeof useSqlQuery>;
  write: ReturnType<typeof useSqlWrite>;
  debugTarget: (error: string) => AiContextTargetDescriptor;
}) {
  const t = useT();
  const error = write.error ?? read.error;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {error ? (
        <AiContextTarget target={debugTarget(error)}>
        <div className="space-y-3 p-4">
          <p className="code-font-size whitespace-pre-wrap font-mono text-destructive">{error}</p>
        </div>
        </AiContextTarget>
      ) : write.committed ? (
        <WriteSummary outcome={write.committed} />
      ) : read.result ? (
        <ResultGrid columns={read.result.columns} rows={read.result.rows} truncated={read.result.truncated} />
      ) : (
        <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
          {t("database.sql.emptyResult")}
        </div>
      )}
    </div>
  );
}

function WriteSummary({ outcome }: { outcome: ReturnType<typeof useSqlWrite>["committed"] }) {
  const t = useT();
  if (!outcome) return null;
  const affected = outcome.affectedRows ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
        <Check className="size-3.5" />
        {t("database.sql.committed", { count: affected })}
      </div>
      {outcome.rows && outcome.rows.length > 0 && outcome.columns ? (
        <ResultGrid columns={outcome.columns} rows={outcome.rows} />
      ) : null}
    </div>
  );
}

function ResultGrid({
  columns,
  rows,
  truncated = false,
}: {
  columns: ColumnInfo[];
  rows: Array<Record<string, unknown>>;
  truncated?: boolean;
}) {
  const t = useT();
  if (columns.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("database.sql.noColumns")}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {truncated ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3.5" />
          {t("database.sql.truncated", { count: rows.length })}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="code-font-size w-max min-w-full border-collapse text-left font-mono">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border">
              {columns.map((col) => (
                <th
                  key={col.name}
                  className="whitespace-nowrap px-3 py-2 font-semibold text-foreground"
                >
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // Query rows have no stable key; index is fine for a read-only view.
              // biome-ignore lint/suspicious/noArrayIndexKey: read-only result
              <tr key={index} className="border-b border-border/60 hover:bg-muted/40">
                {columns.map((col) => (
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
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  {t("database.grid.noRows")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
