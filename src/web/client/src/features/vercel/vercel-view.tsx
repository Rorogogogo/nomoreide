import { useEffect, useState } from "react";
import { disconnectVercel } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useT, type TranslationKey } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { DeploymentDetail } from "./deployment-detail";
import { DeploymentList } from "./deployment-list";
import { DomainsPanel } from "./domains-panel";
import { EnvPanel, type EnvDialogState } from "./env-panel";
import { ProductionHero, type VercelHeroSection } from "./production-hero";
import { ProjectPicker } from "./project-picker";
import { SettingsPanel } from "./settings-panel";
import { StateFilter } from "@/components/ui/tab-strip";
import { TeamSwitcher } from "./team-switcher";
import { VercelAccountMenu } from "./account-menu";
import { useVercelDeployments, type DeploymentFilter } from "./hooks/use-vercel-deployments";
import {
  useVercelDomains,
  useVercelEnv,
  useVercelProductionDeployment,
  useVercelProjectSettings,
} from "./hooks/use-vercel-resource";
import { useVercelStatus } from "./hooks/use-vercel-status";
import { CloseIcon, ExternalIcon, PlusIcon, RefreshIcon, UnlinkIcon } from "./vercel-icons";
import { VercelLogo } from "./vercel-logo";
import { VercelSetup } from "./vercel-setup";

/** Heading shown above a hero section once its chip expands it. */
const HERO_SECTION_LABELS: Record<VercelHeroSection, TranslationKey> = {
  env: "vercel.tabs.env",
  domains: "vercel.tabs.domains",
  settings: "vercel.tabs.settings",
};

export function VercelView() {
  const t = useT();
  const status = useVercelStatus();
  const [forceSetup, setForceSetup] = useState(false);

  let content: React.ReactNode;
  if (status.loading || status.status === "checking") {
    content = <Loading fill label={t("common.loading")} />;
  } else if (forceSetup || status.status === "not_configured") {
    content = (
      <VercelSetup
        info={status.info}
        onCancel={forceSetup ? () => setForceSetup(false) : undefined}
        onConnected={() => {
          setForceSetup(false);
          status.refresh();
        }}
      />
    );
  } else if (status.status === "auth_error" || status.status === "connection_error") {
    content = <VercelConnectionRecovery onReconnect={() => setForceSetup(true)} status={status} />;
  } else if (status.status === "no_project") {
    content = (
      <ProjectPicker onLinked={status.refresh} repositoryName={status.info?.repositoryName} />
    );
  } else {
    // Reuses the setup screen for "sign in as somebody else": connecting is
    // the same flow whether or not a connection already exists, and `onCancel`
    // is what makes it escapable when one does.
    content = <VercelProject onSwitchAccount={() => setForceSetup(true)} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">{content}</div>
  );
}

function VercelConnectionRecovery({
  onReconnect,
  status,
}: {
  onReconnect: () => void;
  status: ReturnType<typeof useVercelStatus>;
}) {
  const t = useT();
  const authError = status.status === "auth_error";

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md space-y-3 rounded-md border border-border bg-card p-4">
        <div className="flex items-start gap-2.5">
          <VercelLogo className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{t("vercel.connFailed")}</h2>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
              {authError ? t("vercel.tokenRejected") : t("vercel.cantValidate")}
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
            {t("vercel.reconnect")}
          </Button>
          <Button
            onClick={() => {
              void disconnectVercel().then(status.refresh);
            }}
            type="button"
            variant="ghost"
          >
            <UnlinkIcon />
            {t("vercel.disconnect")}
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
function VercelProject({ onSwitchAccount }: { onSwitchAccount: () => void }) {
  const t = useT();
  const [filter, setFilter] = usePersistentState<DeploymentFilter>("vercel:filter", "all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { deployments, project, loading, error, hasInFlight, refresh, refreshQuietly } =
    useVercelDeployments(filter);

  // Fetched here rather than inside each panel: the hero's chips summarise this
  // data (counts, domain names, build command) before any section is expanded,
  // and lifting it once avoids fetching it twice.
  const {
    data: env,
    loading: envLoading,
    error: envError,
    refresh: refreshEnv,
  } = useVercelEnv();
  const {
    data: domains,
    loading: domainsLoading,
    error: domainsError,
    refresh: refreshDomains,
  } = useVercelDomains();
  const {
    data: settings,
    loading: settingsLoading,
    error: settingsError,
    refresh: refreshSettings,
  } = useVercelProjectSettings();
  const {
    data: productionDeployment,
    loading: productionLoading,
    refresh: refreshProduction,
  } = useVercelProductionDeployment();
  const [envDialog, setEnvDialog] = useState<EnvDialogState>(null);
  // A hero chip expands its section right below itself, keeping the hero and
  // the deployment history in view. Clicking the same chip again collapses it,
  // and only one section is open at a time.
  const [heroSection, setHeroSection] = useState<VercelHeroSection | null>(null);
  const toggleHeroSection = (section: VercelHeroSection) =>
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
    if (!deployments.some((deployment) => deployment.uid === selectedId)) {
      setSelectedId(deployments[0]?.uid ?? null);
    }
  }, [deployments, selectedId]);

  const selected = deployments.find((deployment) => deployment.uid === selectedId) ?? null;

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <VercelLogo className="size-3.5" />
        <span className="truncate text-[12px] font-medium">
          {project?.name ?? t("nav.vercel")}
        </span>
        {hasInFlight ? (
          <span className="text-[11px] text-amber-500">{t("vercel.buildingNow")}</span>
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          <VercelAccountMenu onSwitchAccount={onSwitchAccount} />
          <TeamSwitcher />
          <StateFilter<DeploymentFilter>
            ariaLabel={t("vercel.filter.label")}
            onChange={setFilter}
            options={[
              { id: "all", label: t("vercel.filter.all") },
              { id: "production", label: t("vercel.target.production") },
              { id: "preview", label: t("vercel.target.preview") },
            ]}
            value={filter}
          />
          {project ? (
            <Button
              onClick={() => openExternal(`https://vercel.com/dashboard`)}
              size="icon-sm"
              title={t("vercel.openDashboard")}
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
        buildLabel={settings?.buildCommand?.trim() || settings?.framework || null}
        deployment={productionDeployment}
        domains={domains}
        envCount={env.length}
        loading={productionLoading}
        onToggleSection={toggleHeroSection}
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
                  title={t("vercel.env.add")}
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
              {t("vercel.deployments.selectHint")}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
