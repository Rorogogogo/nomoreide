import { AlertTriangle, Loader2, ShieldAlert, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerDialog } from "@/features/services/service-form/composer-dialog";
import { useT } from "@/lib/i18n";
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
  const t = useT();
  return (
    <ComposerDialog
      icon={<ShieldAlert className="text-amber-500" />}
      onClose={onClose}
      title={t("database.write.unlockTitle", { connection })}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">{t("database.write.unlockBody1")}</p>
        <p className="text-muted-foreground">{t("database.write.unlockBody2")}</p>
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={onClose} type="button">
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={busy} type="button">
            {busy ? <Loader2 className="animate-spin" /> : <Unlock />}
            {t("database.write.unlockWrites")}
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
  const t = useT();
  return (
    <ComposerDialog
      icon={<AlertTriangle className="text-amber-500" />}
      onClose={onClose}
      title={t("database.write.confirmTitle")}
    >
      <div className="flex flex-col gap-4 text-sm">
        <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
          {sql}
        </pre>
        {preview.previewUnavailable ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
            {t("database.write.previewUnavailable")}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {t("database.write.willAffectPre")}{" "}
            <strong className="text-foreground tabular-nums">
              {preview.affectedRows ?? 0}
            </strong>{" "}
            {t("database.write.willAffectPost")}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={onClose} type="button">
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            className="bg-amber-600 text-white hover:bg-amber-600/90"
            onClick={onConfirm}
            disabled={busy}
            type="button"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("database.write.runCommit")}
          </Button>
        </div>
      </div>
    </ComposerDialog>
  );
}
