import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RuntimeEnvStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Amber notice shown in the Env tab when a running service's config files were
 * edited after it started — the live process still holds the old values until
 * it's relaunched. "Reload service" does that in one click.
 */
export function EnvRuntimeBanner({
  runtime,
  reloading,
  onReload,
}: {
  runtime: RuntimeEnvStatus | undefined;
  reloading: boolean;
  onReload: () => void;
}) {
  const t = useT();
  if (!runtime?.stale) return null;
  const files = runtime.staleFiles;
  const summary =
    files.length === 1
      ? t("services.env.staleOne", { file: files[0].relativePath })
      : t("services.env.staleMany", { count: files.length });

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-700 dark:text-amber-400">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" />
        <span>{t("services.env.staleBanner", { summary })}</span>
      </div>
      <Button disabled={reloading} onClick={onReload} size="sm" type="button" variant="outline">
        <RotateCw /> {reloading ? t("services.env.reloading") : t("services.env.reloadService")}
      </Button>
    </div>
  );
}
