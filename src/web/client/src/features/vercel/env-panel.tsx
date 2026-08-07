import { useState } from "react";
import { getVercelEnvValue, type VercelEnvVar } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { useToasts } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useVercelEnv } from "./hooks/use-vercel-resource";
import { CopyIcon, HideIcon, RevealIcon } from "./vercel-icons";

/** The order Vercel itself lists environments in, rather than alphabetical. */
const TARGET_ORDER = ["production", "preview", "development"];

/**
 * Only the three standard targets are translated. Custom environments carry
 * user-chosen names, which are not ours to translate, so those render verbatim.
 */
const TARGET_LABEL = {
  production: "vercel.env.target.production",
  preview: "vercel.env.target.preview",
  development: "vercel.env.target.development",
} as const;

/**
 * The project's environment variables — the question a failed deploy actually
 * raises ("is this key even set, and where?").
 *
 * Values are absent until asked for: the list carries keys and targets only,
 * and revealing one is a per-row POST. So opening this tab puts no secret on
 * the wire, and every value that does leave Vercel corresponds to a click.
 */
export function EnvPanel() {
  const t = useT();
  const { data: env, loading, error, refresh } = useVercelEnv();
  useRegisterRefresh(refresh);

  if (loading && env.length === 0) return <Loading fill label={t("common.loading")} />;
  if (error) {
    return (
      <p className="break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {error}
      </p>
    );
  }
  if (env.length === 0) {
    return <p className="p-4 text-[12px] text-muted-foreground">{t("vercel.env.empty")}</p>;
  }

  return (
    <div className="divide-y divide-border">
      {env.map((variable) => (
        <EnvRow key={variable.id} variable={variable} />
      ))}
    </div>
  );
}

function EnvRow({ variable }: { variable: VercelEnvVar }) {
  const t = useT();
  const toasts = useToasts();
  const [value, setValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  /**
   * `system` variables (Vercel's own `VERCEL_URL` and friends) are computed per
   * deployment and have no stored value to read, so the reveal control would
   * only ever produce an error.
   */
  const revealable = variable.type !== "system";

  async function reveal() {
    if (value !== null) {
      setValue(null);
      return;
    }
    setRevealing(true);
    try {
      setValue(await getVercelEnvValue(variable.id));
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRevealing(false);
    }
  }

  async function copy() {
    const text = value ?? (await getVercelEnvValue(variable.id).catch(() => null));
    if (text === null) return;
    await navigator.clipboard.writeText(text);
    toasts.success(t("vercel.env.copied", { key: variable.key }));
  }

  const targets = [...variable.target].sort(
    (a, b) => TARGET_ORDER.indexOf(a) - TARGET_ORDER.indexOf(b),
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium">
        {variable.key}
      </code>

      <span className="flex shrink-0 flex-wrap items-center gap-1">
        {targets.map((target) => (
          <span
            className={cn(
              "rounded border px-1.5 py-px text-[10px] capitalize",
              target === "production"
                ? "border-emerald-500/40 text-emerald-500"
                : "border-border text-muted-foreground",
            )}
            key={target}
          >
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
            {t("vercel.env.system")}
          </span>
        ) : null}
      </span>

      {revealable ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <Button
            loading={revealing}
            onClick={() => void reveal()}
            size="icon-sm"
            title={value === null ? t("vercel.env.reveal") : t("vercel.env.hide")}
            type="button"
            variant="ghost"
          >
            {value === null ? <RevealIcon /> : <HideIcon />}
          </Button>
          <Button
            onClick={() => void copy()}
            size="icon-sm"
            title={t("vercel.env.copy")}
            type="button"
            variant="ghost"
          >
            <CopyIcon />
          </Button>
        </span>
      ) : null}

      {value !== null ? (
        <code className="w-full break-all rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] leading-relaxed">
          {value || t("vercel.env.emptyValue")}
        </code>
      ) : null}
    </div>
  );
}
