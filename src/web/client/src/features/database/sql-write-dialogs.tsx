import { AlertTriangle, Loader2, ShieldAlert, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerDialog } from "@/features/services/service-form/composer-dialog";
import { type WriteOutcome } from "@/lib/api";

/**
 * Confirmation gate shown before a connection's write lock is opened. Unlocking
 * is a deliberate, human-only act — the agent never reaches this path.
 */
export function UnlockDialog({
  connection,
  busy,
  onConfirm,
  onClose,
}: {
  connection: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ComposerDialog
      icon={<ShieldAlert className="text-amber-500" />}
      onClose={onClose}
      title={`Unlock writes on "${connection}"?`}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">
          This lets the SQL console run statements that <strong>change data</strong>{" "}
          — <span className="font-mono">INSERT</span>,{" "}
          <span className="font-mono">UPDATE</span>,{" "}
          <span className="font-mono">DELETE</span>, and DDL like{" "}
          <span className="font-mono">DROP</span>. Writes still preview their
          affected rows before they commit, but an unlocked connection can modify
          or destroy real data.
        </p>
        <p className="text-muted-foreground">
          The lock stays open for this connection until you re-lock it. It is
          never shared with the AI agent.
        </p>
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={busy} type="button">
            {busy ? <Loader2 className="animate-spin" /> : <Unlock />}
            Unlock writes
          </Button>
        </div>
      </div>
    </ComposerDialog>
  );
}

/**
 * Affected-rows preview shown before a write commits. The preview already ran
 * in a rolled-back transaction, so nothing has persisted yet.
 */
export function WritePreviewDialog({
  sql,
  preview,
  busy,
  onConfirm,
  onClose,
}: {
  sql: string;
  preview: WriteOutcome;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ComposerDialog
      icon={<AlertTriangle className="text-amber-500" />}
      onClose={onClose}
      title="Confirm write"
    >
      <div className="flex flex-col gap-4 text-sm">
        <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
          {sql}
        </pre>
        {preview.previewUnavailable ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
            This statement can’t be previewed — DDL commits immediately on this
            engine and cannot be rolled back. Running it applies the change at
            once.
          </p>
        ) : (
          <p className="text-muted-foreground">
            This will affect{" "}
            <strong className="text-foreground tabular-nums">
              {preview.affectedRows ?? 0}
            </strong>{" "}
            row{preview.affectedRows === 1 ? "" : "s"}. The preview ran in a
            transaction that was rolled back — nothing has changed yet.
          </p>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-amber-600 text-white hover:bg-amber-600/90"
            onClick={onConfirm}
            disabled={busy}
            type="button"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            Run &amp; commit
          </Button>
        </div>
      </div>
    </ComposerDialog>
  );
}
