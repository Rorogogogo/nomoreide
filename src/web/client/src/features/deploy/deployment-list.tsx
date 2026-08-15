import type { ProviderDeployment } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn, formatRelativeTime } from "@/lib/utils";
import { DeploymentStateDot } from "./deployment-state-badge";

export function DeploymentList({
  deployments,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  deployments: ProviderDeployment[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (uid: string) => void;
}) {
  const t = useT();

  if (loading && deployments.length === 0) {
    return (
      <div className="p-4 text-[12px] text-muted-foreground">{t("provider.deployments.loading")}</div>
    );
  }
  if (error) {
    return <div className="p-4 text-[12px] text-red-500">{error}</div>;
  }
  if (deployments.length === 0) {
    return (
      <div className="p-4 text-[12px] text-muted-foreground">{t("provider.deployments.empty")}</div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {deployments.map((deployment) => (
        <li key={deployment.id}>
          <button
            aria-current={selectedId === deployment.id || undefined}
            className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
              selectedId === deployment.id ? "bg-muted/45" : ""
            }`}
            onClick={() => onSelect(deployment.id)}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <DeploymentStateDot state={deployment.state} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {deployment.meta.commitMessage || deployment.url || deployment.id}
                </span>
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {[
                  deployment.meta.branch,
                  deployment.meta.sha?.slice(0, 7),
                  deployment.creator?.username,
                  formatRelativeTime(new Date(deployment.createdAt).toISOString()),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            {deployment.target === "production" ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    deployment.isCurrentProduction ? "bg-emerald-500" : "bg-muted-foreground/50",
                  )}
                />
                {t("provider.target.production")}
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                {t("provider.target.preview")}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
