import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Lock,
  LockOpen,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { ColumnInfo, DatabaseEngine } from "@/lib/api";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
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
import { UnlockDialog, WritePreviewDialog } from "./sql-write-dialogs";

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
  unlocked,
  seed,
  onWriteAccessChange,
  preferences = { confirmWrites: true, resultLimit: 100 },
}: {
  connection: string;
  engine?: DatabaseEngine;
  unlocked: boolean;
  /** A statement staged from the dock agent, dropped into the editor (not run). */
  seed?: { sql: string; nonce: number } | null;
  onWriteAccessChange: () => void;
  preferences?: { confirmWrites: boolean; resultLimit: number };
}) {
  const { success: showSuccess } = useToasts();
  const { sendToAgent } = useAgentDock();
  const read = useSqlQuery(connection);
  const write = useSqlWrite(connection);
  const access = useWriteAccess(connection, onWriteAccessChange);
  const [sql, setSql] = useState(seed?.sql ?? "");
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
  const [showUnlock, setShowUnlock] = useState(false);
  const generate = useSqlGenerate(connection, engine, unlocked, setSql);

  // A non-SELECT statement is a write regardless of the lock; whether we *run*
  // it (preview path) or block on the unlock gate depends on `unlocked`.
  const isWriteStatement = sql.trim().length > 0 && !isReadStatement(sql);
  const isWrite = unlocked && isWriteStatement;
  const needsUnlock = isWriteStatement && !unlocked;
  const running = read.running || write.previewing || write.committing;

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

  // Hand the failed statement + engine error to the dock so the agent can
  // explain the cause and propose a fix. Opens the dock (mode "send").
  function debugError(error: string) {
    sendToAgent({
      prompt: buildDebugSqlPrompt(connection, engine, sql, error),
      source: { type: "database-sql-debug", label: "Debug SQL" },
      label: "Debug this SQL error",
    });
  }

  async function commitWrite(statement?: string) {
    const outcome = await write.commit(statement);
    if (outcome?.committed) {
      const affected = outcome.affectedRows ?? 0;
      showSuccess(`Committed — ${affected} row${affected === 1 ? "" : "s"} affected.`);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border p-2">
        <GenerateField generate={generate} />
        <textarea
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder={
            unlocked
              ? "SELECT … / INSERT … / UPDATE …   (Cmd/Ctrl+Enter to run)"
              : "SELECT * FROM …   (read-only — Cmd/Ctrl+Enter to run)"
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
                aria-label="Max rows"
                className="rounded-md border border-border bg-background px-1.5 py-1 text-[11px]"
                value={limit}
                onChange={(event) => {
                  customizedLimitRef.current = true;
                  setLimit(Number(event.target.value));
                }}
              >
                {databaseLimitOptions(preferences.resultLimit).map((size) => (
                  <option key={size} value={size}>
                    {size} rows
                  </option>
                ))}
              </select>
            ) : null}
            <Button
              size="sm"
              className={cn("h-7 px-3", isWrite && "bg-amber-600 text-white hover:bg-amber-600/90")}
              onClick={submit}
              disabled={running || !sql.trim()}
              type="button"
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {isWrite ? (preferences.confirmWrites ? "Preview write" : "Run write") : "Run"}
            </Button>
          </div>
        </div>
      </div>

      <ResultArea read={read} write={write} onDebug={debugError} />

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
            placeholder="Describe the query in plain English — AI writes the SQL below"
            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-[12px] outline-none focus:border-ring disabled:opacity-60"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-3"
          onClick={submit}
          disabled={generate.generating || !intent.trim()}
          type="button"
        >
          {generate.generating ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <AgentMark className="size-3.5" />
          )}
          {generate.generating ? "Generating…" : "Ask AI"}
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
      title={unlocked ? "Writes unlocked — click to lock" : "Read-only — click to unlock writes"}
    >
      {updating ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : unlocked ? (
        <LockOpen className="size-3.5" />
      ) : (
        <Lock className="size-3.5" />
      )}
      {unlocked ? "Writes unlocked" : "Read-only"}
    </button>
  );
}

/** Renders the active result: a committed write summary, query rows, or errors. */
function ResultArea({
  read,
  write,
  onDebug,
}: {
  read: ReturnType<typeof useSqlQuery>;
  write: ReturnType<typeof useSqlWrite>;
  onDebug: (error: string) => void;
}) {
  const error = write.error ?? read.error;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {error ? (
        <div className="space-y-3 p-4">
          <p className="code-font-size whitespace-pre-wrap font-mono text-destructive">{error}</p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-3"
            onClick={() => onDebug(error)}
            type="button"
          >
            <AgentMark className="size-3.5" />
            Debug with AI
          </Button>
        </div>
      ) : write.committed ? (
        <WriteSummary outcome={write.committed} />
      ) : read.result ? (
        <ResultGrid columns={read.result.columns} rows={read.result.rows} truncated={read.result.truncated} />
      ) : (
        <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
          Write a query and run it to see results here.
        </div>
      )}
    </div>
  );
}

function WriteSummary({ outcome }: { outcome: ReturnType<typeof useSqlWrite>["committed"] }) {
  if (!outcome) return null;
  const affected = outcome.affectedRows ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
        <Check className="size-3.5" />
        Committed — {affected} row{affected === 1 ? "" : "s"} affected.
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
  if (columns.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Query ran successfully — no columns returned.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {truncated ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3.5" />
          Showing the first {rows.length} rows — add a LIMIT to narrow the result.
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
                  No rows.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
