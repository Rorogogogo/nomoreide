import { useState } from "react";
import { Download, GitBranch, PackageSearch, Search, Star, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AgentEnvRegistryProfileSort,
  AgentEnvRegistryProfileSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { useRegistryProfiles } from "./use-registry-profiles";

const SORT_OPTIONS = [
  { value: "recent", labelKey: "agentEnv.registrySort.recent" },
  { value: "stars", labelKey: "agentEnv.registrySort.stars" },
  { value: "downloads", labelKey: "agentEnv.registrySort.downloads" },
  { value: "alpha", labelKey: "agentEnv.registrySort.alpha" },
] as const satisfies readonly {
  value: AgentEnvRegistryProfileSort;
  labelKey:
    | "agentEnv.registrySort.recent"
    | "agentEnv.registrySort.stars"
    | "agentEnv.registrySort.downloads"
    | "agentEnv.registrySort.alpha";
}[];

export function RegistryProfilesPanel({
  busy,
  catalog,
  onInstall,
}: {
  busy: boolean;
  catalog: ReturnType<typeof useRegistryProfiles>;
  onInstall: (slug: string) => Promise<boolean>;
}) {
  const t = useT();
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);

  const install = async (slug: string) => {
    setInstallingSlug(slug);
    try {
      await onInstall(slug);
    } finally {
      setInstallingSlug(null);
    }
  };

  return (
    <section
      aria-labelledby="agent-profiles-registry-title"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      id="agent-profiles-panel-registry"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/75 px-3 py-2">
        <span
          className="shrink-0 text-[11px] font-medium"
          id="agent-profiles-registry-title"
        >
          {t("agentEnv.registryTitle")}
        </span>
        <label className="relative min-w-44 flex-1 sm:max-w-sm">
          <span className="sr-only">{t("agentEnv.registrySearchAria")}</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            className="h-7 w-full rounded border border-border bg-background pl-7 pr-7 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => catalog.setQuery(event.target.value)}
            placeholder={t("agentEnv.registrySearchPlaceholder")}
            type="search"
            value={catalog.query}
          />
          {catalog.query ? (
            <button
              aria-label={t("agentEnv.registryClearSearch")}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => catalog.setQuery("")}
              type="button"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          ) : null}
        </label>
        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {t("agentEnv.registrySort")}
          <select
            className="h-7 rounded border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) =>
              catalog.setSort(event.target.value as AgentEnvRegistryProfileSort)
            }
            value={catalog.sort}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {catalog.error ? (
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
          <p className="min-w-0 truncate text-[11px] text-destructive" title={catalog.error}>
            {t("agentEnv.registryLoadFailed")}: {catalog.error}
          </p>
          <Button onClick={catalog.retry} size="sm" variant="outline">
            {t("agentEnv.retry")}
          </Button>
        </div>
      ) : null}

      {catalog.error ? null : catalog.loading && catalog.profiles.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {t("agentEnv.registryLoadingProfiles")}
        </p>
      ) : catalog.profiles.length === 0 ? (
        <div className="flex min-h-32 flex-1 flex-col items-center justify-center gap-1 px-3 py-8 text-center">
          <PackageSearch aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {catalog.query
              ? t("agentEnv.registryNoMatches", { query: catalog.query.trim() })
              : t("agentEnv.registryNoProfiles")}
          </p>
        </div>
      ) : (
        <ul
          aria-busy={catalog.loading || undefined}
          className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto"
        >
          {catalog.profiles.map((profile) => (
            <RegistryProfileRow
              busy={busy}
              installing={installingSlug === profile.slug}
              key={profile.id}
              onInstall={() => void install(profile.slug)}
              profile={profile}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RegistryProfileRow({
  busy,
  installing,
  onInstall,
  profile,
}: {
  busy: boolean;
  installing: boolean;
  onInstall: () => void;
  profile: AgentEnvRegistryProfileSummary;
}) {
  const t = useT();
  const counts = [
    ["agentEnv.mcpCountOne", "agentEnv.mcpCountMany", profile.mcpCount],
    ["agentEnv.skillCountOne", "agentEnv.skillCountMany", profile.skillCount],
    ["agentEnv.pluginCountOne", "agentEnv.pluginCountMany", profile.pluginCount],
  ] as const;

  return (
    <li className="flex flex-wrap items-center gap-2.5 px-3 py-2 transition-colors hover:bg-muted/20">
      <span className="min-w-48 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-xs font-medium" title={profile.title}>
            {profile.title}
          </span>
          <code className="truncate text-[10px] text-muted-foreground" title={profile.slug}>
            {profile.slug}
          </code>
          <code className="text-[10px] text-muted-foreground">v{profile.version}</code>
          {profile.author?.displayName ? (
            <span
              className="truncate text-[10px] text-muted-foreground"
              title={t("agentEnv.registryAuthor", { author: profile.author.displayName })}
            >
              {t("agentEnv.registryAuthor", { author: profile.author.displayName })}
            </span>
          ) : null}
        </span>
        {profile.summary ? (
          <span className="block truncate text-[11px] text-muted-foreground" title={profile.summary}>
            {profile.summary}
          </span>
        ) : null}
      </span>

      <span className="flex flex-wrap items-center gap-1">
        {counts.map(([one, many, count]) =>
          count > 0 ? (
            <Badge key={many} size="small" variant="outline">
              {t(count === 1 ? one : many, { count })}
            </Badge>
          ) : null,
        )}
      </span>

      <span className="hidden shrink-0 items-center gap-2 text-[10px] text-muted-foreground sm:flex">
        <span className="flex items-center gap-1">
          <GitBranch aria-hidden="true" className="size-3" />
          {profile.sourceKind === "github" ? "GitHub" : t("agentEnv.registryPackage")}
        </span>
        <span className="flex items-center gap-1" title={t("agentEnv.registryStars")}>
          <Star aria-hidden="true" className="size-3" />
          {profile.starsCount.toLocaleString()}
        </span>
        <span className="flex items-center gap-1" title={t("agentEnv.registryDownloads")}>
          <Download aria-hidden="true" className="size-3" />
          {profile.downloadsCount.toLocaleString()}
        </span>
      </span>

      <Button
        disabled={busy}
        loading={installing}
        loadingLabel={t("agentEnv.registryInstalling")}
        onClick={onInstall}
        size="sm"
        variant="outline"
      >
        <Download aria-hidden="true" />
        {t("agentEnv.install")}
      </Button>
    </li>
  );
}
