import { useState } from "react";
import { Bookmark, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerDialog } from "@/features/services/service-form/composer-dialog";
import { useT } from "@/lib/i18n";

/** The two dialogs the query tabs open: discard-unsaved, and save-as. */

export function UnsavedQueryDialog({
  onCancel,
  onDiscard,
  onSave,
}: {
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <ComposerDialog
      icon={<X className="text-destructive" />}
      onClose={onCancel}
      title={t("database.sql.closeUnsavedQueryTitle")}
    >
      <p className="text-sm text-muted-foreground">{t("database.sql.closeUnsavedQueryBody")}</p>
      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          {t("common.cancel")}
        </Button>
        <Button onClick={onDiscard} size="sm" type="button" variant="destructive">
          {t("database.sql.discardChanges")}
        </Button>
        <Button onClick={onSave} size="sm" type="button">
          <Save />
          {t("common.save")}
        </Button>
      </div>
    </ComposerDialog>
  );
}

export function SaveQueryDialog({
  defaultName,
  onClose,
  onSave,
}: {
  defaultName: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(defaultName);
  const trimmedName = name.trim();

  return (
    <ComposerDialog
      icon={<Bookmark />}
      onClose={onClose}
      title={t("database.sql.saveQueryTitle")}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedName) onSave(trimmedName);
        }}
      >
        <label className="block space-y-1.5 text-xs font-medium">
          <span>{t("database.sql.queryName")}</span>
          <input
            className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:border-ring"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("database.sql.queryNamePlaceholder")}
            value={name}
          />
        </label>
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("common.cancel")}
          </Button>
          <Button disabled={!trimmedName} size="sm" type="submit">
            <Save />
            {t("database.sql.saveQuery")}
          </Button>
        </div>
      </form>
    </ComposerDialog>
  );
}

