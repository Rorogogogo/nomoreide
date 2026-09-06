import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  BookOpen,
  ChevronRight,
  LayoutGrid,
  PanelLeft,
  Settings,
} from "lucide-react";
import {
  getDashboard,
  selectGitRepository,
  type DashboardData,
  type OverviewDomain,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Loading } from "@/components/ui/loading";
import { Tooltip } from "@/components/ui/tooltip";
import {
  headerActionClassName,
  headerActionIconClassName,
} from "@/components/header-action";
import { HeaderRefreshButton, type RefreshPhase } from "@/components/header-refresh-button";
import { AgentView } from "@/features/agent/agent-view";
import { ContextView } from "@/features/context/context-view";
import { AgentEnvView } from "@/features/agent-env/agent-env-view";
import { AgentProvider, useAgentDock } from "@/features/agent/chat/agent-context";
import { AiContextMenuProvider } from "@/features/agent/context-menu/ai-context-menu";
import { AgentTerminalDock, type AgentDockPage } from "@/features/agent/terminal/agent-terminal-dock";
import { DatabaseView } from "@/features/database/database-view";
import { SettingsView } from "@/features/settings/settings-view";
import {
  SettingsProvider,
  useSettings,
} from "@/features/settings/settings-context";
import { ErrorInboxView } from "@/features/errors/error-inbox-view";
import { HomeView } from "@/features/home/home-view";
import { ServicesView } from "@/features/services/services-view";
import { DockerView } from "@/features/docker/docker-view";
import { RunningStripe } from "@/features/services/running-stripe";
import { GitReviewView } from "@/features/git/git-review-view";
import { GitHubView } from "@/features/github/github-view";
import { GitHubHeaderIndicator } from "@/features/github/github-header-indicator";
import { GlobalSearch } from "@/features/global-search/global-search";
import {
  ExtensionIcon,
  ExtensionPage,
  UnknownExtensionPage,
} from "@/features/extensions/extension-page";
import { ExtensionsView } from "@/features/extensions/extensions-view";
import { useInstalledExtensions } from "@/features/extensions/use-installed-extensions";
import { ProjectOverviewTable } from "@/features/overview/project-overview-table";
import { refreshGitHubToken } from "@/features/github/hooks/use-github-token";
import { ProjectBreadcrumb } from "@/features/git/project-breadcrumb";
import { BranchBreadcrumb } from "@/features/git/branch-breadcrumb";
import { scopeDashboard } from "@/features/services/project-scope";
import { BranchControls } from "@/features/git/branch-controls";
import { useToasts } from "@/components/ui/toast";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  RefreshRegistryProvider,
  useRefreshRegistry,
} from "@/components/refresh-registry";
import { cn } from "@/lib/utils";
import { TauriTitleBar } from "@/components/tauri-titlebar";
import { useT, } from "@/lib/i18n";
import { OperationProvider } from "@/components/operations/operation-context";
import { OperationStrip } from "@/components/operations/operation-strip";
import { ScrollProgressBar } from "@/components/ui/scroll-progress-bar";
import { AppContextMenu } from "@/components/app-context-menu";
import { ActivityPage } from "@/features/activity/activity-page";
import { ServersView } from "@/features/servers/servers-view";
import { RemoteView } from "@/features/remote/remote-view";
import { GistPopover } from "@/components/gist-popover";
import { DaemonSkewBanner } from "@/components/daemon-skew-banner";
import { RuntimeDiagnostics } from "@/components/runtime-diagnostics";
import {
  getRuntimeConnectionSnapshot,
  probeRuntimeHealth,
  recordRuntimeReachable,
  useRuntimeConnection,
} from "@/lib/runtime-connection";
import { isTauri } from "@/lib/tauri";
import {
  APP_NAV_SECTIONS,
  APP_NAV_ITEMS,
  type AppPage,
} from "@/components/app-navigation";

import { useWorkspaceLayout, type WorkspaceTab } from "@/features/workspace/workspace-layout";
import { WorkspaceView } from "@/features/workspace/workspace-view";
import {
  AppIdentity,
  NavButton,
  NavSectionLabel,
  SidebarDockToggle,
  sidebarShellClassName,
} from "@/components/app-sidebar";
import {
  extensionIdFromPath,
  extensionPath,
  initialPage,
  installSlugFromSearch,
  PAGE_PATHS,
  PAGE_TITLE_KEY,
  pageFromPath,
} from "@/app-routing";

type Page = AppPage;

export function App({ syncLocation = true }: { syncLocation?: boolean } = {}) {
  return (
    <SettingsProvider>
      <OperationProvider>
        <AppContent syncLocation={syncLocation} />
      </OperationProvider>
    </SettingsProvider>
  );
}

export function SettingsProjectSync({
  projectPath,
  selectProject,
}: {
  projectPath: string | null;
  selectProject: (path: string | null) => Promise<void>;
}) {
  useEffect(() => {
    void selectProject(projectPath);
  }, [projectPath, selectProject]);
  return null;
}

function AppContent({ syncLocation }: { syncLocation: boolean }) {
  const t = useT();
  const runtimeConnection = useRuntimeConnection();
  const [, startTransition] = useTransition();
  // Read once at mount: the location-sync effect below rewrites the URL to the
  // active page's path as soon as the page changes, dropping the query string.
  const [pendingInstall, setPendingInstall] = useState<string | null>(() =>
    syncLocation ? installSlugFromSearch(window.location.search) : null,
  );
  /*
    The embedded demo still opens on Services, deliberately — it is mounted
    with `syncLocation={false}` in the marketing hero, where the point is to
    show the workbench managing real services. Changing what the site leads
    with is a marketing decision, not a consequence of Home taking "/".
  */
  const [initialTab] = useState<WorkspaceTab>(() => ({
    page: syncLocation ? initialPage(window.location) : "services",
    extensionId: syncLocation ? extensionIdFromPath(window.location.pathname) : null,
  }));
  const { extensions } = useInstalledExtensions();
  const [activityHost, setActivityHost] = useState("local");
  const [data, setData] = useState<DashboardData | null>(null);
  const workspace = useWorkspaceLayout(
    data ? data.git.selectedRepository?.path ?? data.git.cwd ?? "all" : null,
    initialTab,
    syncLocation,
  );
  useEffect(() => {
    if (!syncLocation) return;
    const onPopState = () => workspace.navigate(pageFromPath(window.location.pathname), extensionIdFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [syncLocation, workspace.navigate]);
  const { page, extensionId } = workspace.current;
  const setPage = (next: Page) => workspace.navigate(next);
  const setExtensionId = (id: string | null) => workspace.navigate("extensions", id);
  // Set when the dock's "Open" shortcut should jump to a service on the Services page.
  const [focusService, setFocusService] = useState<string | null>(null);
  // Set when the dock stages an agent-drafted write for the SQL console. The
  // nonce re-fires the stage even if the same statement is opened twice.
  const [stagedSql, setStagedSql] = useState<{
    connection: string;
    sql: string;
    nonce: number;
  } | null>(null);
  // Bumped when an Error Inbox fix asks to review its change-set, so the Agent
  // page opens its Changes tab (which auto-selects the newest session).
  const [changesFocusNonce, setChangesFocusNonce] = useState(0);
  const [agentDockInset, setAgentDockInset] = useState<{
    placement: "bottom" | "right";
    resizing: boolean;
    size: number;
  }>({ placement: "bottom", resizing: false, size: 36 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Refresh-cycle status surfaced by the header button (see `runRefreshCycle`).
  const [refreshPhase, setRefreshPhase] = useState<RefreshPhase>("idle");
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const doneTimerRef = useRef<number | null>(null);
  const {
    error: showErrorToast,
    message: showMessageToast,
  } = useToasts();
  const { ui, updateUi, selectProject } = useSettings();
  const sidebarDocked = ui.sidebarDocked;
  const extensionsExpanded = ui.extensionsExpanded;
  // Project scope: "All projects" (default) leaves the Run pages machine-wide;
  // picking a project filters them to services under that repo. Git/GitHub
  // always follow the daemon-selected repository.
  const scopeAll = ui.projectScope === "all";
  const setScopeAll = useCallback(
    (next: boolean) => updateUi({ projectScope: next ? "all" : "project" }),
    [updateUi],
  );
  const handleAgentDockInsetChange = useCallback(
    (placement: "bottom" | "right", size: number, resizing: boolean) => {
      setAgentDockInset((current) =>
        current.placement === placement &&
        current.resizing === resizing &&
        current.size === size
          ? current
          : { placement, resizing, size },
      );
    },
    [],
  );

  const refreshRegistry = useRefreshRegistry();
  // The registry object is a fresh literal each render; its callbacks are not.
  // Depend on the callback so the refresh cycle (and the poll interval built on
  // it) stays stable.
  const runActiveRefresh = refreshRegistry.runActive;

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const nextData = await getDashboard();
      if (options.silent) {
        // Polling keeps status current, but it must not interrupt typing or
        // terminal interactions with a synchronous whole-dashboard render.
        startTransition(() => setData(nextData));
      } else {
        setData(nextData);
      }
      if (!isTauri()) recordRuntimeReachable();
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      if (!options.silent) showErrorToast(message);
      const connectionPhase = getRuntimeConnectionSnapshot().phase;
      if (
        !isTauri() &&
        (connectionPhase === "initializing" || connectionPhase === "connected")
      ) {
        void probeRuntimeHealth();
      }
      // Reported, not rethrown: every caller is a fire-and-forget `void
      // refresh(...)`, so the outcome travels back as a value instead.
      return false;
    } finally {
      setLoading(false);
    }
  }, [showErrorToast, startTransition]);

  // One refresh cycle = the shared dashboard payload *plus* whatever the active
  // page fetches on its own (GitHub, Database, commit graph), so both the header
  // button and the 5s poll refresh what the user is actually looking at.
  //
  // The button is also the cycle's status light, which is why the auto path runs
  // through here too: the user gets one honest "when was this last current?"
  // read instead of a spinner that only ever reacts to their own clicks.
  const runRefreshCycle = useCallback(
    async (options: { manual?: boolean } = {}) => {
      const manual = options.manual === true;
      if (doneTimerRef.current !== null) {
        window.clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
      // A click should spin immediately. The poll must not: at 5s intervals a
      // spinner that fires on every tick strobes, so the auto path only shows
      // one once the cycle is slow enough to be worth noticing.
      let slowTimer: number | null = null;
      if (manual) {
        setRefreshPhase("busy");
      } else {
        slowTimer = window.setTimeout(() => setRefreshPhase("busy"), 600);
      }
      const [dashboardOk, pageOk] = await Promise.all([
        refresh({ silent: !manual }),
        runActiveRefresh({ manual }).then(
          () => true,
          () => false,
        ),
      ]);
      if (slowTimer !== null) window.clearTimeout(slowTimer);

      if (!dashboardOk || !pageOk) {
        // `refresh` already surfaced the message (error badge + toast); the icon
        // staying red is what makes a daemon that stopped answering visible
        // without having to catch the last toast.
        setRefreshPhase("error");
        return;
      }

      setRefreshedAt(Date.now());
      if (manual) {
        // The click's own confirmation — a toast for something the user just
        // asked for and can see the result of is noise.
        setRefreshPhase("done");
        doneTimerRef.current = window.setTimeout(() => {
          doneTimerRef.current = null;
          setRefreshPhase("idle");
        }, 1400);
      } else {
        setRefreshPhase("idle");
      }
    },
    [refresh, runActiveRefresh],
  );

  const refreshAll = useCallback(() => {
    void runRefreshCycle({ manual: true });
  }, [runRefreshCycle]);
  const refreshAfterReconnect = useCallback(
    () => runRefreshCycle(),
    [runRefreshCycle],
  );

  // Child `onRefresh` props are typed `() => Promise<void>`; `refresh` now
  // reports success as a value, so hand them a void-returning view of it.
  const refreshView = useCallback(async () => {
    await refresh();
  }, [refresh]);
  const refreshSilently = useCallback(async () => {
    await refresh({ silent: true });
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (doneTimerRef.current !== null) window.clearTimeout(doneTimerRef.current);
    };
  }, []);

  useEffect(() => {
    void refresh({ silent: true }).then((ok) => {
      if (ok) setRefreshedAt(Date.now());
    });
  }, [refresh]);

  useEffect(() => {
    function refreshIfVisible() {
      if (document.visibilityState === "visible") {
        // Reload the shared dashboard payload *and* whatever the active page
        // fetches itself (git graph, database, GitHub) so the poll keeps the
        // on-screen view current, not just the services/git overview. The agent
        // page deliberately registers no handler because its profile data owns
        // its own lifecycle; native terminal sessions remain attached separately.
        void runRefreshCycle();
      }
    }

    const interval = window.setInterval(refreshIfVisible, 5000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
    // `runRefreshCycle` closes over `runActive` (a stable callback) rather than
    // the registry object (a fresh literal each render), so it stays stable and
    // the interval is only re-armed when the page actually changes.
  }, [page, runRefreshCycle]);

  useEffect(() => {
    if (!syncLocation) return;
    const path =
      page === "extensions" && extensionId ? extensionPath(extensionId) : PAGE_PATHS[page];
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }, [page, extensionId, syncLocation]);

  const activeProject = (!scopeAll && data?.git.selectedRepository) || null;
  const scopedData = useMemo(
    () => (data && activeProject ? scopeDashboard(data, activeProject) : data),
    [data, activeProject],
  );
  const scopedServiceNames = useMemo(
    () =>
      activeProject && scopedData
        ? new Set(scopedData.config.services.map((service) => service.name))
        : null,
    [activeProject, scopedData],
  );

  // Badge matches what the Services page shows, so it respects the scope.
  const runningCount = useMemo(
    () =>
      scopedData
        ? Object.values(scopedData.runtime.services).filter(
            (service) => service.state === "running",
          ).length
        : 0,
    [scopedData],
  );
  const repoScopeKey =
    data?.git.selectedRepository?.name ?? data?.git.cwd ?? "no-git-repository";
  const settingsProjectPath = data?.git.selectedRepository?.path ?? null;
  /**
   * Git, GitHub, and Vercel read the daemon's selected repository, so a single
   * one of their views can only ever be about one project. Under an
   * all-projects scope they therefore render the overview grid instead —
   * clicking a card selects that project and drops the scope, which lands the
   * user back on the same page, now pointed at what they picked.
   */
  /** The plugin the second-layer nav has open, resolved against what is installed. */
  const activeExtension = extensionId
    ? (extensions.find((entry) => entry.id === extensionId) ?? null)
    : null;
  /** A deploy plugin's page follows the selected repository, exactly as Deploy did. */
  const onDeployExtension = page === "extensions" && activeExtension?.kind === "deploy";
  const repoScopedPage = page === "git" || page === "github" || onDeployExtension;
  /**
   * Page → overview domain.
   *
   * The page now *is* named after a provider, which removes the old cast
   * hazard — but `project-overview.ts` still keys its column set on `vercel`
   * alone (tax #4 in the provider-registry plan: making it generic means
   * deciding which provider each project uses, a UX question). So Cloudflare's
   * page under an all-projects scope gets no grid rather than a Vercel grid
   * with somebody else's name on it.
   */
  const overviewDomain: OverviewDomain | null = !scopeAll || !repoScopedPage
    ? null
    : onDeployExtension
      ? (extensionId === "vercel" ? "vercel" : null)
      : (page as OverviewDomain);
  const effectiveProject =
    repoScopedPage && !scopeAll ? data?.git.selectedRepository ?? null : activeProject;

  // GitHub identity (repo + credential) is resolved per selected repository, so
  // a project switch invalidates it wherever it is rendered — including the
  // header indicator, which no longer mounts a private copy of the state.
  useEffect(() => {
    if (repoScopeKey === "no-git-repository") return;
    void refreshGitHubToken();
  }, [repoScopeKey]);

  const renderWorkspacePage = (tab: WorkspaceTab, pane: number) => {
    const { page, extensionId } = tab;
    const setPage = (next: Page) => workspace.navigate(next, null, pane);
    const setExtensionId = (id: string | null) => workspace.navigate("extensions", id, pane);
    const activeExtension = extensions.find((entry) => entry.id === extensionId) ?? null;
    const overviewDomain: OverviewDomain | null = !scopeAll ? null
      : page === "git" || page === "github" ? page
      : page === "extensions" && activeExtension?.kind === "deploy" && extensionId === "vercel" ? "vercel" : null;
    return <>
            {page === "home" && (scopedData || loading) ? (
              <HomeView
                data={scopedData}
                onOpen={setPage}
                onRefresh={refreshView}
                scopeName={activeProject?.name ?? null}
              />
            ) : null}
            {scopedData && page === "services" ? (
              <ServicesView
                data={scopedData}
                onRefresh={refreshView}
                focusService={focusService}
                onServiceFocused={() => setFocusService(null)}
                scopeName={activeProject?.name ?? null}
              />
            ) : null}
            {scopedData && page === "activity" ? (
              <ActivityPage
                data={scopedData}
                host={activityHost}
                onHostChange={setActivityHost}
                onOpenService={(name) => {
                  setFocusService(name);
                  setPage("services");
                }}
                scopeName={activeProject?.name ?? null}
              />
            ) : null}
            {page === "servers" ? (
              <ServersPage
                onOpenActivity={(host) => {
                  setActivityHost(host);
                  setPage("activity");
                }}
              />
            ) : null}
            {page === "docker" ? <DockerView /> : null}
            {overviewDomain ? (
              <ProjectOverviewTable
                domain={overviewDomain}
                key={overviewDomain}
                onEnterProject={() => {
                  setScopeAll(false);
                  void refresh({ silent: true });
                }}
              />
            ) : null}
            {!overviewDomain && data && page === "git" ? (
              <GitReviewView data={data} onRefresh={() => void refresh({ silent: true })} />
            ) : null}
            {!overviewDomain && page === "github" ? (
              <GitHubView key={repoScopeKey} scope={repoScopeKey} />
            ) : null}
            {/*
              Extensions is two destinations behind one page id: the section's
              own page at `/extensions`, and one plugin's page at
              `/extensions/<id>`. `repoScopeKey` stays in the key because a
              deploy plugin's page follows the selected repository, exactly as
              the Deploy page did.
            */}
            {!overviewDomain && page === "extensions" && extensionId ? (
              activeExtension ? (
                <ExtensionPage
                  extension={activeExtension}
                  key={`${activeExtension.id}:${repoScopeKey}`}
                  onOpenServers={() => setPage("servers")}
                />
              ) : extensions.length > 0 ? (
                <UnknownExtensionPage id={extensionId} />
              ) : null
            ) : null}
            {!overviewDomain && page === "extensions" && !extensionId ? (
              <ExtensionsView onOpen={(id) => setExtensionId(id)} />
            ) : null}
            {page === "remote" ? <RemoteView /> : null}
            {page === "agent" ? (
              <AgentView
                focusChanges={changesFocusNonce}
                onOpenAgentEnv={() => setPage("agent-env")}
              />
            ) : null}
            {page === "context" ? <ContextView projectPath={activeProject?.path ?? null} /> : null}
            {page === "agent-env" ? (
              <AgentEnvView
                installSlug={pendingInstall}
                onInstallHandled={() => setPendingInstall(null)}
              />
            ) : null}
            {page === "errors" ? (
              <ErrorInboxView
                inScope={
                  scopedServiceNames
                    ? (service) => scopedServiceNames.has(service)
                    : undefined
                }
                onReviewChanges={() => {
                  setChangesFocusNonce((nonce) => nonce + 1);
                  setPage("agent");
                }}
              />
            ) : null}
            {page === "database" ? (
              <DatabaseView
                projects={data?.config.gitRepositories ?? []}
                scopePath={activeProject?.path ?? null}
                staged={stagedSql}
                onStageConsumed={() => setStagedSql(null)}
              />
            ) : null}
            {page === "settings" ? (
              <SettingsView
                activeProject={data?.git.selectedRepository ?? null}
                onNavigate={(nextPage) => setPage(nextPage)}
              />
            ) : null}
    </>;
  };
  const workspaceOptions: WorkspaceTab[] = [
    ...APP_NAV_ITEMS.map((item) => ({ page: item.page, extensionId: null })),
    ...extensions.map((extension) => ({ page: "extensions" as const, extensionId: extension.id })),
    { page: "settings", extensionId: null },
  ];
  const workspaceTitle = (tab: WorkspaceTab) => tab.extensionId
    ? extensions.find((entry) => entry.id === tab.extensionId)?.name ?? tab.extensionId
    : t(PAGE_TITLE_KEY[tab.page]);

  return (
    <AgentProvider>
    <AiContextMenuProvider>
    <SettingsProjectSync
      projectPath={settingsProjectPath}
      selectProject={selectProject}
    />
    <RefreshRegistryProvider value={refreshRegistry}>
    <AppContextMenu onRefresh={refreshAll}>
    <div className="flex flex-col h-screen overflow-hidden">
    <ScrollProgressBar key={page} type="bar" strokeSize={2} />
    <TauriTitleBar />
    <div
      className={cn(
        "flex-1 overflow-hidden",
        !agentDockInset.resizing &&
          "transition-[padding] duration-150 motion-reduce:transition-none",
      )}
      style={agentDockInset.placement === "right"
        ? { paddingRight: agentDockInset.size }
        : { paddingBottom: agentDockInset.size }}
    >
      <div className="flex h-full w-full min-w-0" data-workbench-shell>
        <aside className={sidebarShellClassName(sidebarDocked)}>
          <div
            className={cn(
              "grid h-12 grid-cols-[48px_minmax(0,1fr)] items-center overflow-hidden transition-[width] duration-150",
              sidebarDocked ? "w-full" : "w-12 group-hover/sidebar:w-full",
            )}
          >
            <div className="flex size-12 items-center justify-center">
              <div className="flex size-9 items-center justify-center overflow-hidden rounded-md bg-primary text-primary-foreground">
                <svg
                  aria-label="NoMoreIDE"
                  className="size-6"
                  fill="none"
                  role="img"
                  viewBox="0 0 64 64"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M5 17C5 13.69 7.69 11 11 11H25L31 17H53C56.31 17 59 19.69 59 23V53C59 56.31 56.31 59 53 59H11C7.69 59 5 56.31 5 53V17Z"
                    fill="currentColor"
                  />
                  <path
                    d="M22 31L30 39L22 47"
                    stroke="hsl(var(--primary))"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="4.5"
                  />
                  <path
                    d="M36 47H48"
                    stroke="hsl(var(--primary))"
                    strokeLinecap="round"
                    strokeWidth="4.5"
                  />
                </svg>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-1 pr-1">
              <AppIdentity
                className={cn(
                  "min-w-0 flex-1 translate-x-1 overflow-hidden transition-opacity duration-200",
                  sidebarDocked ? "opacity-100" : "opacity-0 group-hover/sidebar:opacity-100",
                )}
              />
              <SidebarDockToggle
                docked={sidebarDocked}
                onToggleDock={() => updateUi({ sidebarDocked: !sidebarDocked })}
              />
            </div>
          </div>
          {/* Project scope lives in the header breadcrumb, not here — one
              control for one piece of state. */}
          <nav className="mt-2 flex-1 content-start overflow-y-auto overflow-x-hidden">
            {APP_NAV_SECTIONS.map((section, index) => (
              <div className={cn(index > 0 && "mt-1.5")} key={section.labelKey}>
                <NavSectionLabel docked={sidebarDocked} label={t(section.labelKey)} />
                <div className="grid gap-0.5">
                  {section.items.map((item) => (
                    <div className="relative grid gap-0.5" key={item.page}>
                      {/*
                        Extensions is a heading, not a destination: clicking it
                        folds its plugins away rather than navigating anywhere.
                        Owner's call — the row named a page nobody wanted, and
                        the plugins underneath are the actual destinations.
                      */}
                      <NavButton
                        active={item.expandable ? false : page === item.page}
                        badge={item.page === "services" ? runningCount : undefined}
                        docked={sidebarDocked}
                        expanded={item.expandable ? extensionsExpanded : undefined}
                        icon={item.icon}
                        label={t(item.labelKey)}
                        onClick={() => {
                          if (item.expandable) {
                            updateUi({ extensionsExpanded: !extensionsExpanded });
                            return;
                          }
                          setPage(item.page);
                        }}
                      />
                      {/*
                        The second layer. The section's own page first, then one
                        row per installed plugin, from `/api/extensions` — so a
                        plugin appears here without any nav file naming it.
                        The overview needs its own row because the parent is a
                        disclosure now and no longer navigates anywhere.
                      */}
                      {item.expandable && extensionsExpanded ? (
                        <NavButton
                          active={page === "extensions" && !extensionId}
                          child
                          docked={sidebarDocked}
                          icon={<LayoutGrid />}
                          label={t("nav.extensionsOverview")}
                          onClick={() => {
                            setExtensionId(null);
                          }}
                        />
                      ) : null}
                      {item.expandable && extensionsExpanded
                        ? extensions.map((extension) => (
                            <NavButton
                              active={page === "extensions" && extensionId === extension.id}
                              child
                              docked={sidebarDocked}
                              icon={<ExtensionIcon extension={extension} />}
                              key={extension.id}
                              label={extension.name}
                              onClick={() => {
                                setExtensionId(extension.id);
                              }}
                            />
                          ))
                        : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="mt-1 border-t border-border/60 pt-1">
            <NavButton
              active={page === "settings"}
              docked={sidebarDocked}
              icon={<Settings />}
              label={t("nav.settings")}
              onClick={() => setPage("settings")}
            />
          </div>
        </aside>

        <main
          className="flex h-full min-w-0 flex-1 flex-col px-0 py-0"
        >
          <header
            className={cn(
              "relative z-40 flex shrink-0 flex-wrap items-center justify-between gap-3 border border-border bg-card/90 px-3 py-1.5 backdrop-blur",
              "border-x-0 border-t-0 border-b",
            )}
          >
            {/* One line: project scope, its branch when a single project is
                selected, then the page they scope. Each crumb is also its own
                picker, so the hierarchy stays visible while remaining useful. */}
            <div className="flex min-w-0 items-center gap-1">
              <PanelLeft className="mr-1 size-4 shrink-0 text-muted-foreground md:hidden" />
              {data ? (
                <ProjectBreadcrumb
                  data={data}
                  onRefresh={refreshSilently}
                  onScopeChange={setScopeAll}
                  scopeAll={scopeAll}
                />
              ) : null}
              {data && effectiveProject ? (
                <>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                  <BranchBreadcrumb
                    ahead={data.git.status?.ahead ?? 0}
                    behind={data.git.status?.behind ?? 0}
                    branches={data.git.branches}
                    currentBranch={data.git.status?.branch || undefined}
                    disabled={!data.git.status}
                    onRefresh={refreshSilently}
                    upstream={data.git.status?.upstream}
                  />
                </>
              ) : null}
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
              <h1 className="truncate px-1 text-sm font-semibold tracking-tight">
                {/* A plugin's page is titled after the plugin: "Extensions"
                    names the section, and every second-layer page would
                    otherwise share one title. */}
                {activeExtension?.name ?? t(PAGE_TITLE_KEY[page])}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              {error && runtimeConnection.phase === "connected" ? (
                <Badge variant="danger">{error}</Badge>
              ) : null}
              <RuntimeDiagnostics onReconnect={refreshAfterReconnect} />
              <GlobalSearch
                data={data}
                onNavigate={(nextPage) => setPage(nextPage)}
                onOpenGit={() => {
                  setScopeAll(false);
                  setPage("git");
                }}
                onOpenService={(name) => {
                  if (scopedServiceNames && !scopedServiceNames.has(name)) {
                    setScopeAll(true);
                    showMessageToast({ text: t("app.serviceOutsideScope") });
                  }
                  setFocusService(name);
                  setPage("services");
                  void refreshSilently();
                }}
                onSelectProject={async (name) => {
                  await selectGitRepository(name);
                  setScopeAll(false);
                  await refreshSilently();
                  setPage("services");
                }}
              />
              <GitHubHeaderIndicator onOpenGitHub={() => setPage("github")} />
              <div
                aria-label="Dashboard quick actions"
                className="flex items-center gap-1"
                role="toolbar"
              >
                <HeaderRefreshButton
                  onClick={refreshAll}
                  phase={loading && !data ? "busy" : refreshPhase}
                  updatedAt={refreshedAt}
                />
                <ThemeToggle />
                <Tooltip align="end" label={t("action.docs")}>
                  <a
                    aria-label={t("action.docsTitle")}
                    className={headerActionClassName()}
                    href="https://www.nomoreide.com/docs"
                    rel="noreferrer"
                    target="_blank"
                  >
                    <span className={headerActionIconClassName()}>
                      <BookOpen />
                    </span>
                  </a>
                </Tooltip>
                <GistPopover
                  aggregateProjects={scopeAll}
                  key={scopeAll ? "all" : data?.git.selectedRepository?.path ?? "all"}
                  projects={data?.config.gitRepositories ?? []}
                  scopeKey={scopeAll ? "all" : data?.git.selectedRepository?.path ?? "all"}
                />
              </div>
            </div>
          </header>

          {/* Above everything: a daemon two versions behind produces failures
              that read as ordinary bugs, so this has to be seen before they
              are believed. */}
          <DaemonSkewBanner />

          {/* No wrapper here: OperationStrip renders nothing while idle, and a
              padded wrapper around it left an empty strip under the header on
              every page. It carries its own spacing instead. */}
          <OperationStrip />

          {data ? (
            <RunningStripe
              data={data}
              onOpenService={(name) => {
                // The stripe is machine-wide; widen the scope when it points
                // at a service the current project filter would hide.
                if (scopedServiceNames && !scopedServiceNames.has(name)) {
                  setScopeAll(true);
                  showMessageToast({
                    text: t("app.serviceOutsideScope"),
                  });
                }
                setFocusService(name);
                setPage("services");
                void refreshSilently();
              }}
            />
          ) : null}

          {loading && !data && page !== "home" ? (
            <Loading className="py-8" label={t("app.loading")} />
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkspaceView layout={workspace.layout} update={workspace.update}
              options={workspaceOptions} title={workspaceTitle} render={renderWorkspacePage} />
          </div>
        </main>
      </div>
      {/* Acts on the selected repository, which is not what the overview grid
          is about — it would silently target whichever project happens to be
          selected behind the grid. */}
      {data && page === "git" && !overviewDomain ? (
        <BranchControls
          ahead={data.git.status?.ahead ?? 0}
          behind={data.git.status?.behind ?? 0}
          branches={data.git.branches}
          currentBranch={data.git.status?.branch || undefined}
          disabled={!data.git.status}
          onRefresh={refreshView}
          upstream={data.git.status?.upstream}
        />
      ) : null}
      <AgentTerminalDock
        currentPage={page}
        git={data?.git}
        onInsetChange={handleAgentDockInsetChange}
        onNavigate={(nextPage: AgentDockPage) => setPage(nextPage)}
        onGitRefresh={() => void refresh({ silent: true })}
      />
    </div>
    </div>
    </AppContextMenu>
    </RefreshRegistryProvider>
    </AiContextMenuProvider>
    </AgentProvider>
  );
}

function ServersPage({ onOpenActivity }: { onOpenActivity: (host: string) => void }) {
  const { setOpen } = useAgentDock();
  return (
    <ServersView
      onOpenActivity={onOpenActivity}
      onOpenTerminal={() => setOpen(true)}
    />
  );
}
