import type { VercelDeployment } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/utils";
import { DeploymentStateIcon } from "./deployment-state-badge";

export function DeploymentList({
  deployments,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  deployments: VercelDeployment[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (uid: string) => void;
}) {
  const t = useT();

  if (loading && deployments.length === 0) {
    return (
      <div className="p-4 text-[12px] text-muted-foreground">{t("vercel.deployments.loading")}</div>
    );
  }
  if (error) {
    return <div className="p-4 text-[12px] text-red-500">{error}</div>;
  }
  if (deployments.length === 0) {
    return (
      <div className="p-4 text-[12px] text-muted-foreground">{t("vercel.deployments.empty")}</div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {deployments.map((deployment) => (
        <li key={deployment.uid}>
          <button
            aria-current={selectedId === deployment.uid || undefined}
            className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
              selectedId === deployment.uid ? "bg-muted/45" : ""
            }`}
            onClick={() => onSelect(deployment.uid)}
            type="button"
          >
            <span className="mt-0.5">
              <DeploymentStateIcon state={deployment.state} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">
                {deployment.meta.commitMessage || deployment.url || deployment.uid}
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
              <span
                className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${
                  deployment.isCurrentProduction
                    ? "border-emerald-500/40 text-emerald-500"
                    : "border-border text-muted-foreground"
                }`}
              >
                {t("vercel.target.production")}
              </span>
            ) : (
              <span className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                {t("vercel.target.preview")}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
