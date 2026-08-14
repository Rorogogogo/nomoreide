import { useState } from "react";
import {
  type ProviderEnvVar,
} from "@/lib/api";
import { useProviderApi } from "./provider-client";
import { Button } from "@/components/ui/button";
import { ComposerDialog } from "@/features/services/service-form/composer-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/loading";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  CopyIcon,
  EditIcon,
  EnvIcon,
  HideIcon,
  PlusIcon,
  RevealIcon,
  TrashIcon,
} from "./provider-icons";
import { PanelEmpty } from "./panel-empty";

/** The order Vercel itself lists environments in, rather than alphabetical. */
const TARGET_ORDER = ["production", "preview", "development"];

/**
 * Only the three standard targets are translated. Custom environments carry
 * user-chosen names, which are not ours to translate, so those render verbatim.
 */
const TARGET_LABEL = {
  production: "provider.env.target.production",
  preview: "provider.env.target.preview",
  development: "provider.env.target.development",
} as const;

/** What `EnvVarDialog` is editing; absent means it is creating a new one. */
export type EnvDialogTarget = Pick<ProviderEnvVar, "id" | "key" | "environments">;

/** What the panel's add/edit dialog is currently showing, if anything. */
export type EnvDialogState = "add" | EnvDialogTarget | null;

/**
 * The project's environment variables — the question a failed deploy actually
 * raises ("is this key even set, and where?").
 *
 * Values are absent until asked for: the list carries keys and targets only,
 * and revealing one is a per-row POST. So opening this tab puts no secret on
 * the wire, and every value that does leave Vercel corresponds to a click.
 *
 * Writes go through `VercelActions` (create/update/delete), the same guarded,
 * dashboard-only door the deployment actions use — no MCP tool reaches this.
 *
 * Data and the add/edit dialog are both owned by the parent tab view rather
 * than fetched or opened here: the header's variable count and its "add"
 * button (kept in the tab row to save the vertical space a full button would
 * cost) both need to reach the same state this panel renders.
 */
export function EnvPanel({
  env,
  loading,
  error,
  refresh,
  dialog,
  onDialogChange,
}: {
  env: ProviderEnvVar[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  dialog: EnvDialogState;
  onDialogChange: (next: EnvDialogState) => void;
}) {
  const t = useT();

  if (loading && env.length === 0) return <Loading fill label={t("common.loading")} />;
  if (error) {
    return (
      <p className="break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {error}
      </p>
    );
  }

  return (
    <div>
      {env.length === 0 ? (
        <PanelEmpty
          action={
            <Button onClick={() => onDialogChange("add")} size="sm" type="button" variant="outline">
              <PlusIcon />
              {t("provider.env.add")}
            </Button>
          }
          icon={<EnvIcon />}
        >
          {t("provider.env.empty")}
        </PanelEmpty>
      ) : (
        <div className="divide-y divide-border">
          {env.map((variable) => (
            <EnvRow
              key={variable.id}
              onEdit={() =>
                onDialogChange({ id: variable.id, key: variable.key, environments: variable.environments })
              }
              variable={variable}
            />
          ))}
        </div>
      )}

      {dialog ? (
        <EnvVarDialog
          onClose={() => onDialogChange(null)}
          onSaved={() => refresh()}
          target={dialog === "add" ? undefined : dialog}
        />
      ) : null}
    </div>
  );
}

function EnvRow({ variable, onEdit }: { variable: ProviderEnvVar; onEdit: () => void }) {
  const t = useT();
  const api = useProviderApi();
  const toasts = useToasts();
  const [value, setValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /**
   * `system` variables (Vercel's own `VERCEL_URL` and friends) are computed per
   * deployment and have no stored value to read, so the reveal control would
   * only ever produce an error.
   */
  const revealable = variable.type !== "system";
  const editable = variable.type !== "system";

  async function reveal() {
    if (value !== null) {
      setValue(null);
      return;
    }
    setRevealing(true);
    try {
      setValue(await api.getEnvValue(variable.id));
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRevealing(false);
    }
  }

  async function copy() {
    const text = value ?? (await api.getEnvValue(variable.id).catch(() => null));
    if (text === null) return;
    await navigator.clipboard.writeText(text);
    toasts.success(t("provider.env.copied", { key: variable.key }));
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.deleteEnv(variable.id);
      toasts.success(t("provider.env.deleted", { key: variable.key }));
      setConfirmingDelete(false);
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleting(false);
    }
  }

  const targets = [...variable.environments].sort(
    (a, b) => TARGET_ORDER.indexOf(a) - TARGET_ORDER.indexOf(b),
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium">
        {variable.key}
      </code>

      <span className="flex shrink-0 flex-wrap items-center gap-2">
        {targets.map((target) => (
          <span
            className="inline-flex items-center gap-1 text-[10px] capitalize text-muted-foreground"
            key={target}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                target === "production" ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
            />
            {target in TARGET_LABEL
              ? t(TARGET_LABEL[target as keyof typeof TARGET_LABEL])
              : target}
          </span>
        ))}
        {variable.gitBranch ? (
          <span className="rounded border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            {variable.gitBranch}
          </span>
        ) : null}
        {variable.type === "system" ? (
          <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            {t("provider.env.system")}
          </span>
        ) : null}
      </span>

      <span className="flex shrink-0 items-center gap-0.5">
        {revealable ? (
          <Button
            loading={revealing}
            onClick={() => void reveal()}
            size="icon-sm"
            title={value === null ? t("provider.env.reveal") : t("provider.env.hide")}
            type="button"
            variant="ghost"
          >
            {value === null ? <RevealIcon /> : <HideIcon />}
          </Button>
        ) : null}
        {revealable ? (
          <Button
            onClick={() => void copy()}
            size="icon-sm"
            title={t("provider.env.copy")}
            type="button"
            variant="ghost"
          >
            <CopyIcon />
          </Button>
        ) : null}
        {editable ? (
          <Button onClick={onEdit} size="icon-sm" title={t("provider.env.edit")} type="button" variant="ghost">
            <EditIcon />
          </Button>
        ) : null}
        {editable ? (
          <Button
            onClick={() => setConfirmingDelete(true)}
            size="icon-sm"
            title={t("provider.env.delete")}
            type="button"
            variant="ghost"
          >
            <TrashIcon />
          </Button>
        ) : null}
      </span>

      {value !== null ? (
        <code className="w-full break-all rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] leading-relaxed">
          {value || t("provider.env.emptyValue")}
        </code>
      ) : null}

      {confirmingDelete ? (
        <ConfirmDialog
          confirmLabel={t("provider.env.delete")}
          icon={<TrashIcon />}
          loading={deleting}
          message={t("provider.env.deleteConfirm", { key: variable.key })}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void confirmDelete()}
          title={t("provider.env.deleteTitle")}
          tone="danger"
        />
      ) : null}
    </div>
  );
}

/**
 * Add or edit one variable. The key is fixed once created — Vercel has no
 * rename, only delete-and-recreate, which this dialog does not offer as a
 * single step. Editing leaves the value blank to mean "keep the current one",
 * the same convention `AddConnectionDialog` uses for a database password.
 */
function EnvVarDialog({
  target,
  onClose,
  onSaved,
}: {
  target?: EnvDialogTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const api = useProviderApi();
  const toasts = useToasts();
  const isEditing = Boolean(target);
  const [key, setKey] = useState(target?.key ?? "");
  const [value, setValue] = useState("");
  const [targets, setTargets] = useState<Set<string>>(
    new Set(target?.environments ?? ["production", "preview", "development"]),
  );
  const [saving, setSaving] = useState(false);

  function toggleTarget(name: string) {
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function save() {
    if (!key.trim()) {
      toasts.error(t("provider.env.errKeyRequired"));
      return;
    }
    if (targets.size === 0) {
      toasts.error(t("provider.env.errTargetRequired"));
      return;
    }
    if (!isEditing && !value) {
      toasts.error(t("provider.env.errValueRequired"));
      return;
    }
    setSaving(true);
    try {
      if (isEditing && target) {
        await api.updateEnv(target.id, {
          environments: Array.from(targets),
          ...(value ? { value } : {}),
        });
        toasts.success(t("provider.env.updated", { key: key.trim() }));
      } else {
        await api.createEnv({ key: key.trim(), value, environments: Array.from(targets) });
        toasts.success(t("provider.env.created", { key: key.trim() }));
      }
      onSaved();
      onClose();
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ComposerDialog
      icon={<EnvIcon />}
      onClose={onClose}
      size="md"
      title={isEditing ? t("provider.env.editTitle") : t("provider.env.addTitle")}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5" htmlFor="provider-env-key">
          <span className="text-xs font-medium text-muted-foreground">{t("provider.env.key")}</span>
          <Input
            className="font-mono text-xs"
            disabled={isEditing}
            id="provider-env-key"
            onChange={(event) => setKey(event.target.value)}
            placeholder="API_KEY"
            value={key}
          />
        </label>

        <label className="flex flex-col gap-1.5" htmlFor="provider-env-value">
          <span className="text-xs font-medium text-muted-foreground">{t("provider.env.value")}</span>
          <Input
            className="font-mono text-xs"
            id="provider-env-value"
            onChange={(event) => setValue(event.target.value)}
            placeholder={isEditing ? t("provider.env.valueKeep") : "••••••••"}
            type="password"
            value={value}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t("provider.env.targets")}</span>
          <div className="flex flex-wrap gap-1.5">
            {TARGET_ORDER.map((name) => (
              <Button
                key={name}
                onClick={() => toggleTarget(name)}
                size="sm"
                type="button"
                variant={targets.has(name) ? "default" : "outline"}
              >
                {t(TARGET_LABEL[name as keyof typeof TARGET_LABEL])}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("common.cancel")}
          </Button>
          <Button
            loading={saving}
            loadingLabel={t("common.saving")}
            onClick={() => void save()}
            size="sm"
            type="button"
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </ComposerDialog>
  );
}
