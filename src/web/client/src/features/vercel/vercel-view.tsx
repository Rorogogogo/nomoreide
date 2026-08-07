import { useEffect, useState } from "react";
import { disconnectVercel } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useT, type TranslationKey } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { DeploymentDetail } from "./deployment-detail";
import { DeploymentList } from "./deployment-list";
import { DomainsPanel } from "./domains-panel";
import { EnvPanel } from "./env-panel";
import { ProjectPicker } from "./project-picker";
import { SettingsPanel } from "./settings-panel";
import { StateFilter, TabStrip } from "@/components/ui/tab-strip";
import { TeamSwitcher } from "./team-switcher";
import { VercelAccountMenu } from "./account-menu";
import { useVercelDeployments, type DeploymentFilter } from "./hooks/use-vercel-deployments";
import { useVercelStatus } from "./hooks/use-vercel-status";
import { ExternalIcon, RefreshIcon, UnlinkIcon } from "./vercel-icons";
import { VercelLogo } from "./vercel-logo";
import { VercelSetup } from "./vercel-setup";

type VercelTab = "deployments" | "env" | "domains" | "settings";

const VERCEL_TABS: readonly { id: VercelTab; label: TranslationKey }[] = [
  { id: "deployments", label: "vercel.tabs.deployments" },
  { id: "env", label: "vercel.tabs.env" },
  { id: "domains", label: "vercel.tabs.domains" },
  { id: "settings", label: "vercel.tabs.settings" },
];

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
    content = <VercelProjectTabs onSwitchAccount={() => setForceSetup(true)} />;
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
 * The deployment list keeps polling while a build runs, so it stays mounted
 * behind the other tabs rather than being torn down and re-fetched on every
 * tab switch.
 */
function VercelProjectTabs({ onSwitchAccount }: { onSwitchAccount: () => void }) {
  const t = useT();
  const [tab, setTab] = usePersistentState<VercelTab>("vercel:tab", "deployments");
  const [filter, setFilter] = usePersistentState<DeploymentFilter>("vercel:filter", "all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { deployments, project, loading, error, hasInFlight, refresh, refreshQuietly } =
    useVercelDeployments(filter);

  useRegisterRefresh(refresh);

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

        <span className="ml-3">
          <TabStrip<VercelTab>
            ariaLabel={t("vercel.tabs.label")}
            idPrefix="vercel"
            onSelect={setTab}
            tabs={VERCEL_TABS.map((entry) => ({ id: entry.id, label: t(entry.label) }))}
            value={tab}
          />
        </span>

        <span className="ml-auto flex items-center gap-2">
          <VercelAccountMenu onSwitchAccount={onSwitchAccount} />
          <TeamSwitcher />
          {/* Scopes the deployment list only, so it goes away with that tab. */}
          {tab === "deployments" ? (
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
          ) : null}
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

      {/* Hidden rather than unmounted: tearing the list down would stop the
          in-flight build poll every time the user looked at another tab. */}
      <div className={cn("flex min-h-0 flex-1 overflow-hidden", tab !== "deployments" && "hidden")}>
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
            <DeploymentDetail deployment={selected} onChanged={refreshQuietly} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-[12px] text-muted-foreground">
              {t("vercel.deployments.selectHint")}
            </div>
          )}
        </div>
      </div>

      {tab === "env" ? (
        <TabPanel>
          <EnvPanel />
        </TabPanel>
      ) : null}
      {tab === "domains" ? (
        <TabPanel>
          <DomainsPanel />
        </TabPanel>
      ) : null}
      {tab === "settings" ? (
        <TabPanel>
          <SettingsPanel />
        </TabPanel>
      ) : null}
    </>
  );
}

/**
 * A tab's content area.
 *
 * These panels are lists of short rows — a domain and its target, a setting and
 * its value. Left to fill the window they strand that content against the far
 * edges with a thousand empty pixels in between, which reads as a page that
 * failed to load rather than a short list. Capping the column keeps the pairs
 * near each other, and matches the all-projects table.
 */
function TabPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="w-full max-w-3xl px-3 py-3">{children}</div>
    </div>
  );
}
