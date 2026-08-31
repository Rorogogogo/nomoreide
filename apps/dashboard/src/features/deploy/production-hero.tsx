import type { ProviderDeployment, ProviderDomain } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { cn, formatRelativeTime } from "@/lib/utils";
import { DeploymentStateBadge } from "./deployment-state-badge";
import { DomainsIcon, EnvIcon, ExternalIcon, SettingsIcon } from "./provider-icons";

/** Domains not scoped to a preview branch — what's actually serving production. */
const MAX_DOMAIN_CHIPS = 2;

/** Which of the hero's chips has its detail expanded below it, if any. */
export type HeroSection = "env" | "domains" | "settings";

/**
 * What's live right now, pinned above the deployment history.
 *
 * The view used to default to "whatever the current filter's top row is",
 * which is not necessarily production — a preview push after the last prod
 * deploy would bump it out of view entirely. Most people opening this page
 * want the answer to "is prod up, and where do I find it" without reading a
 * build list first, so this renders independently of the list's own filter
 * and selection.
 *
 * The chips are the only way into env / domains / build: they expand inline
 * below the hero (see `ProviderProject`), keeping the hero and the deployment
 * history in view instead of navigating away from them.
 */
export function ProductionHero({
  deployment,
  loading,
  domains,
  envCount,
  buildLabel,
  activeSection,
  onToggleSection,
  showDomains = true,
  showEnv = true,
}: {
  deployment: ProviderDeployment | null;
  loading: boolean;
  domains: ProviderDomain[];
  envCount: number;
  buildLabel: string | null;
  activeSection: HeroSection | null;
  onToggleSection: (section: HeroSection) => void;
  /** False when the provider's manifest does not declare the `domains` capability. */
  showDomains?: boolean;
  /** False when the provider's manifest does not declare the `env` capability. */
  showEnv?: boolean;
}) {
  const t = useT();

  if (loading && !deployment) {
    return (
      <div className="flex shrink-0 items-center justify-center border-b border-border px-4 py-3">
        <Loading label={t("common.loading")} />
      </div>
    );
  }
  if (!deployment) return null;

  const liveDomains = domains.filter((domain) => !domain.gitBranch);
  const shownDomains = showDomains ? liveDomains.slice(0, MAX_DOMAIN_CHIPS) : [];
  const moreDomains = domains.length - shownDomains.length;

  return (
    <div className="shrink-0 space-y-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <DeploymentStateBadge rawState={deployment.rawState} state={deployment.state} />
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("provider.hero.production")}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {formatRelativeTime(new Date(deployment.createdAt).toISOString())}
        </span>
        {deployment.url ? (
          <Button
            className="ml-auto"
            onClick={() => openExternal(`https://${deployment.url}`)}
            size="sm"
            type="button"
            variant="outline"
          >
            <ExternalIcon />
            {t("provider.visit")}
          </Button>
        ) : null}
      </div>

      <p className="truncate text-[13px] font-medium">
        {deployment.meta.commitMessage || deployment.url || deployment.id}
      </p>
      <p className="truncate text-[11px] text-muted-foreground">
        {[deployment.meta.branch, deployment.meta.sha?.slice(0, 7), deployment.creator?.username]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <div className="flex flex-wrap items-center gap-1">
        {shownDomains.map((domain) => (
          <Button
            className="h-6 gap-1.5 px-2 font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground"
            key={domain.name}
            onClick={() => openExternal(`https://${domain.name}`)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <DomainsIcon className="size-3.5" />
            {domain.name}
          </Button>
        ))}
        {showDomains && moreDomains > 0 ? (
          <SummaryChip
            active={activeSection === "domains"}
            icon={<DomainsIcon className="size-3.5" />}
            label={t("provider.hero.domainsMore", { count: moreDomains })}
            onClick={() => onToggleSection("domains")}
          />
        ) : null}
        {showEnv ? (
          <SummaryChip
            active={activeSection === "env"}
            icon={<EnvIcon className="size-3.5" />}
            label={t(
              envCount === 1 ? "provider.summary.envCountOne" : "provider.summary.envCountMany",
              { count: envCount },
            )}
            onClick={() => onToggleSection("env")}
          />
        ) : null}
        <SummaryChip
          active={activeSection === "settings"}
          icon={<SettingsIcon className="size-3.5" />}
          label={
            buildLabel
              ? t("provider.summary.build", { value: buildLabel })
              : t("provider.summary.buildDefault")
          }
          onClick={() => onToggleSection("settings")}
        />
      </div>
    </div>
  );
}

function SummaryChip({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      className={cn(
        "h-6 max-w-[220px] gap-1.5 px-2 font-normal text-[11px]",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      size="sm"
      type="button"
      variant="ghost"
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}
