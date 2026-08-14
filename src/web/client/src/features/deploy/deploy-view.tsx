import { useEffect, useMemo, useState } from "react";
import { listProviders, type ProviderManifest, type ProviderProject } from "@/lib/api";
import {
  DEFAULT_PROVIDER_ID,
  ProviderSelectionProvider,
  useCapability,
  useProviderApi,
  useProviderId,
  useProviderName,
} from "./provider-client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useT, type TranslationKey } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { DeploymentDetail } from "./deployment-detail";
import { DeploymentList } from "./deployment-list";
import { DomainsPanel } from "./domains-panel";
import { EnvPanel, type EnvDialogState } from "./env-panel";
import { ProductionHero, type HeroSection } from "./production-hero";
import { ProjectPicker } from "./project-picker";
import { SettingsPanel } from "./settings-panel";
import { StateFilter } from "@/components/ui/tab-strip";
import { ScopeSwitcher } from "./scope-switcher";
import { ProviderAccountMenu } from "./account-menu";
import { useProviderDeployments, type DeploymentFilter } from "./hooks/use-provider-deployments";
import {
  useProviderDomains,
  useProviderEnv,
  useProviderProductionDeployment,
  useProviderProjectSettings,
} from "./hooks/use-provider-resource";
import { useProviderStatus } from "./hooks/use-provider-status";
import { CloseIcon, ExternalIcon, PlusIcon, RefreshIcon, UnlinkIcon } from "./provider-icons";
import { ProviderLogo } from "./provider-logo";
import { ProviderSetup } from "./provider-setup";

/**
 * Where "open the vendor's own dashboard" goes.
 *
 * A per-provider constant is a deliberate small escape from the generic view —
 * §9 of the design plan asks that escaping stays cheap. It belongs in the
 * manifest, which carries no URLs yet; until then a provider that is not listed
 * simply does not get the button, rather than getting one that opens somebody
 * else's dashboard.
 */
const DASHBOARD_URLS: Record<string, string> = {
  vercel: "https://vercel.com/dashboard",
  cloudflare: "https://dash.cloudflare.com/",
};

/** Heading shown above a hero section once its chip expands it. */
const HERO_SECTION_LABELS: Record<HeroSection, TranslationKey> = {
  env: "provider.tabs.env",
  domains: "provider.tabs.domains",
  settings: "provider.tabs.settings",
};

/**
 * What the hero shows under "Build": the provider's build command when it has
 * one, else the framework it detected. Reads the settings list rather than a
 * `buildCommand` field, because which settings exist is the provider's call.
 */
function buildLabel(project: ProviderProject | null): string | null {
  const command = project?.settings.find((setting) => setting.key === "buildCommand")?.value;
  return command?.trim() || project?.framework || null;
}

/**
 * The deploy page: a provider selection wrapped around one generic workspace.
 *
 * Everything below this component is provider-agnostic — it reads the id from
 * context (`provider-client.ts`) and the manifest for what the provider can do.
 * Vercel and Cloudflare render through the identical tree; the only thing that
 * differs is what `/api/providers/:id/*` answers.
 *
 * `key={selected}` on the workspace is load-bearing: switching providers must
 * drop every piece of local state under it — the selected deployment, the open
 * hero section, the loaded env list — rather than showing one provider's data
 * under another's name until each fetch resolves.
 */
export function DeployView() {
  const [providers, setProviders] = useState<ProviderManifest[]>([]);
  const [selected, setSelected] = usePersistentState<string>(
    "deploy:provider",
    DEFAULT_PROVIDER_ID,
  );

  useEffect(() => {
    void listProviders()
      .then(setProviders)
      // A registry that cannot be read is not a reason to blank the page: the
      // stored id still addresses a provider, and capability checks fall back
      // to "assume supported" precisely so this stays usable.
      .catch(() => setProviders([]));
  }, []);

  // A stored id for a provider that no longer exists would otherwise leave the
  // page addressing nothing.
  const known = providers.length === 0 || providers.some((entry) => entry.id === selected);
  const providerId = known ? selected : (providers[0]?.id ?? DEFAULT_PROVIDER_ID);
  const manifest = providers.find((entry) => entry.id === providerId) ?? null;

  const selection = useMemo(() => ({ id: providerId, manifest }), [providerId, manifest]);

  return (
    <ProviderSelectionProvider value={selection}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        {providers.length > 1 ? (
          <ProviderSwitcher onSelect={setSelected} providers={providers} selected={providerId} />
        ) : null}
        <ProviderWorkspace key={providerId} />
      </div>
    </ProviderSelectionProvider>
  );
}

/**
 * One row of provider tabs, shown only when there is more than one to choose
 * from — a single-provider install (everyone today) sees no new chrome.
 *
 * Lives in the shell rather than the connected header so that switching works
 * in every state: the whole point is to reach a provider you have *not*
 * connected yet, which is exactly when the connected header is not rendered.
 */
function ProviderSwitcher({
  onSelect,
  providers,
  selected,
}: {
  onSelect: (id: string) => void;
  providers: ProviderManifest[];
  selected: string;
}) {
  const t = useT();

  return (
    <nav
      aria-label={t("provider.switcher.label")}
      className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5"
    >
      {providers.map((provider) => (
        <button
          aria-current={provider.id === selected ? "page" : undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5",
            provider.id === selected && "bg-muted text-foreground",
          )}
          key={provider.id}
          onClick={() => onSelect(provider.id)}
          type="button"
        >
          <ProviderLogo providerId={provider.id} />
          <span>{provider.name}</span>
        </button>
      ))}
    </nav>
  );
}

function ProviderWorkspace() {
  const t = useT();
  const status = useProviderStatus();
  const [forceSetup, setForceSetup] = useState(false);

  let content: React.ReactNode;
  if (status.loading || status.status === "checking") {
    content = <Loading fill label={t("common.loading")} />;
  } else if (forceSetup || status.status === "not_configured") {
    content = (
      <ProviderSetup
        info={status.info}
        onCancel={forceSetup ? () => setForceSetup(false) : undefined}
        onConnected={() => {
          setForceSetup(false);
          status.refresh();
        }}
      />
    );
  } else if (status.status === "auth_error" || status.status === "connection_error") {
    content = <ProviderConnectionRecovery onReconnect={() => setForceSetup(true)} status={status} />;
  } else if (status.status === "no_project") {
    content = (
      <ProjectPicker onLinked={status.refresh} repositoryName={status.info?.repositoryName} />
    );
  } else {
    // Reuses the setup screen for "sign in as somebody else": connecting is
    // the same flow whether or not a connection already exists, and `onCancel`
    // is what makes it escapable when one does.
    content = <ConnectedProject onSwitchAccount={() => setForceSetup(true)} />;
  }

  return <>{content}</>;
}

function ProviderConnectionRecovery({
  onReconnect,
  status,
}: {
  onReconnect: () => void;
  status: ReturnType<typeof useProviderStatus>;
}) {
  const t = useT();
  const api = useProviderApi();
  const name = useProviderName();
  const authError = status.status === "auth_error";

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md space-y-3 rounded-md border border-border bg-card p-4">
        <div className="flex items-start gap-2.5">
          <ProviderLogo className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t("provider.connFailed", { name })}</h2>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
              {authError
                ? t("provider.tokenRejected", { name })
                : t("provider.cantValidate", { name })}
            </p>
          </div>
        </div>

        {/*
          The heading already carries the failure; this is the diagnostic
          detail, so it reads as quiet technical text rather than a second
          alarm competing with it.
        */}
        {status.error ? (
          <p className="break-words rounded border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {status.error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={status.refresh} type="button" variant={authError ? "outline" : "default"}>
            <RefreshIcon />
            {t("common.refresh")}
          </Button>
          <Button onClick={onReconnect} type="button" variant={authError ? "default" : "outline"}>
            {t("provider.reconnect", { name })}
          </Button>
          <Button
            onClick={() => {
              void api.disconnect().then(status.refresh);
            }}
            type="button"
            variant="ghost"
          >
            <UnlinkIcon />
            {t("provider.disconnect")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The connected project. Connection identity belongs to the header indicator,
 * so this is only ever about the project itself — its deployments, what it is
 * configured with, and what it is reachable at.
 *
 * There is deliberately only one view: the production hero over the deployment
 * history, with env / domains / build expanding inline from the hero's chips.
 * These used to also be reachable as their own top-level tabs, which meant two
 * entry points rendering the identical panel — the redundancy cost a tab strip
 * and a mode to keep track of without buying anything the chips don't.
 */
function ConnectedProject({ onSwitchAccount }: { onSwitchAccount: () => void }) {
  const t = useT();
  const providerName = useProviderName();
  // The manifest deciding what renders. Cloudflare declares no `runtimeLogs`,
  // so its log panel shows one tab rather than a second that always errors.
  const canEnv = useCapability("env");
  const canDomains = useCapability("domains");
  const providerId = useProviderId();
  const dashboardUrl = DASHBOARD_URLS[providerId];
  const [filter, setFilter] = usePersistentState<DeploymentFilter>("deploy:filter", "all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { deployments, project, loading, error, hasInFlight, refresh, refreshQuietly } =
    useProviderDeployments(filter);

  // Fetched here rather than inside each panel: the hero's chips summarise this
  // data (counts, domain names, build command) before any section is expanded,
  // and lifting it once avoids fetching it twice.
  const {
    data: env,
    loading: envLoading,
    error: envError,
    refresh: refreshEnv,
  } = useProviderEnv(canEnv);
  const {
    data: domains,
    loading: domainsLoading,
    error: domainsError,
    refresh: refreshDomains,
  } = useProviderDomains(canDomains);
  const {
    data: settings,
    loading: settingsLoading,
    error: settingsError,
    refresh: refreshSettings,
  } = useProviderProjectSettings();
  const {
    data: productionDeployment,
    loading: productionLoading,
    refresh: refreshProduction,
  } = useProviderProductionDeployment();
  const [envDialog, setEnvDialog] = useState<EnvDialogState>(null);
  // A hero chip expands its section right below itself, keeping the hero and
  // the deployment history in view. Clicking the same chip again collapses it,
  // and only one section is open at a time.
  const [heroSection, setHeroSection] = useState<HeroSection | null>(null);
  const toggleHeroSection = (section: HeroSection) =>
    setHeroSection((current) => (current === section ? null : section));

  useRegisterRefresh(refresh);
  useRegisterRefresh(refreshEnv);
  useRegisterRefresh(refreshDomains);
  useRegisterRefresh(refreshSettings);
  useRegisterRefresh(refreshProduction);

  // Keep a selection pinned to something that still exists: the filter change
  // or a redeploy can drop the row that was open.
  useEffect(() => {
    if (deployments.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!deployments.some((deployment) => deployment.id === selectedId)) {
      setSelectedId(deployments[0]?.id ?? null);
    }
  }, [deployments, selectedId]);

  const selected = deployments.find((deployment) => deployment.id === selectedId) ?? null;

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <ProviderLogo className="size-3.5" providerId={providerId} />
        <span className="truncate text-[12px] font-medium">
          {project?.name ?? t("nav.deploy")}
        </span>
        {hasInFlight ? (
          <span className="text-[11px] text-amber-500">{t("provider.buildingNow")}</span>
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          <ProviderAccountMenu onSwitchAccount={onSwitchAccount} />
          <ScopeSwitcher />
          <StateFilter<DeploymentFilter>
            ariaLabel={t("provider.filter.label")}
            onChange={setFilter}
            options={[
              { id: "all", label: t("provider.filter.all") },
              { id: "production", label: t("provider.target.production") },
              { id: "preview", label: t("provider.target.preview") },
            ]}
            value={filter}
          />
          {project && dashboardUrl ? (
            <Button
              onClick={() => openExternal(dashboardUrl)}
              size="icon-sm"
              title={t("provider.openDashboard", { name: providerName })}
              type="button"
              variant="ghost"
            >
              <ExternalIcon />
            </Button>
          ) : null}
        </span>
      </header>

      <ProductionHero
        activeSection={heroSection}
        buildLabel={buildLabel(settings)}
        deployment={productionDeployment}
        domains={domains}
        envCount={env.length}
        loading={productionLoading}
        onToggleSection={toggleHeroSection}
        showDomains={canDomains}
        showEnv={canEnv}
      />

      {/* Capped rather than free-growing so the deployment history underneath
          never gets pushed off screen by a long variable list. */}
      {heroSection ? (
        <div className="flex max-h-[40vh] shrink-0 flex-col overflow-hidden border-b border-border">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t(HERO_SECTION_LABELS[heroSection])}
            </span>
            <span className="flex items-center gap-1">
              {/* Sits with the section it acts on rather than in the page
                  header, and as an icon rather than a full "Add variable"
                  button so it costs no extra row. */}
              {heroSection === "env" ? (
                <Button
                  onClick={() => setEnvDialog("add")}
                  size="icon-sm"
                  title={t("provider.env.add")}
                  type="button"
                  variant="ghost"
                >
                  <PlusIcon />
                </Button>
              ) : null}
              <Button
                onClick={() => setHeroSection(null)}
                size="icon-sm"
                title={t("common.close")}
                type="button"
                variant="ghost"
              >
                <CloseIcon />
              </Button>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {heroSection === "env" ? (
              <EnvPanel
                dialog={envDialog}
                env={env}
                error={envError}
                loading={envLoading}
                onDialogChange={setEnvDialog}
                refresh={refreshEnv}
              />
            ) : null}
            {heroSection === "domains" ? (
              <DomainsPanel domains={domains} error={domainsError} loading={domainsLoading} />
            ) : null}
            {heroSection === "settings" ? (
              <SettingsPanel error={settingsError} loading={settingsLoading} project={settings} />
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-[min(360px,42%)] shrink-0 overflow-auto border-r border-border">
          <DeploymentList
            deployments={deployments}
            error={error}
            loading={loading}
            onSelect={setSelectedId}
            selectedId={selectedId}
          />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          {selected ? (
            <DeploymentDetail
              deployment={selected}
              onChanged={() => {
                refreshQuietly();
                refreshProduction();
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-[12px] text-muted-foreground">
              {t("provider.deployments.selectHint")}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
