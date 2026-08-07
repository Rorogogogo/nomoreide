import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import {
  BookOpen,
  ChevronRight,
  Heart,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import {
  getDashboard,
  type DashboardData,
  type OverviewDomain,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Tooltip } from "@/components/ui/tooltip";
import {
  headerActionClassName,
  headerActionIconClassName,
} from "@/components/header-action";
import { HeaderRefreshButton, type RefreshPhase } from "@/components/header-refresh-button";
import { AgentView } from "@/features/agent/agent-view";
import { AgentEnvView } from "@/features/agent-env/agent-env-view";
import { AgentProvider } from "@/features/agent/chat/agent-context";
import { AiContextMenuProvider } from "@/features/agent/context-menu/ai-context-menu";
import { WorkflowRunProvider } from "@/features/workflows/workflow-run-context";
import { WorkflowTriggerProvider } from "@/features/workflows/workflow-trigger-context";
import { AgentTerminalDock, type AgentDockPage } from "@/features/agent/terminal/agent-terminal-dock";
import { DatabaseView } from "@/features/database/database-view";
import { SettingsView } from "@/features/settings/settings-view";
import {
  SettingsProvider,
  useSettings,
} from "@/features/settings/settings-context";
import { ErrorInboxView } from "@/features/errors/error-inbox-view";
import { ServicesView } from "@/features/services/services-view";
import { DockerView } from "@/features/docker/docker-view";
import { RunningStripe } from "@/features/services/running-stripe";
import { TerminalView } from "@/features/terminal/terminal-view";
import { GitReviewView } from "@/features/git/git-review-view";
import { WorkflowPanel } from "@/features/workflows/workflow-panel";
import { GitHubView } from "@/features/github/github-view";
import { GitHubHeaderIndicator } from "@/features/github/github-header-indicator";
import { VercelView } from "@/features/vercel/vercel-view";
import { ProjectOverviewGrid } from "@/features/overview/project-overview-grid";
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
import { useT, type TranslationKey } from "@/lib/i18n";
import { OperationProvider } from "@/components/operations/operation-context";
import { OperationStrip } from "@/components/operations/operation-strip";
import { ScrollProgressBar } from "@/components/ui/scroll-progress-bar";
import { AppContextMenu } from "@/components/app-context-menu";
import { ActivityView } from "@/features/activity/activity-view";
import {
  APP_NAV_SECTIONS,
  type AppPage,
} from "@/components/app-navigation";

type Page = AppPage;

const PAGE_PATHS: Record<Page, string> = {
  services: "/",
  activity: "/activity",
  docker: "/docker",
  git: "/git",
  github: "/github",
  vercel: "/vercel",
  workflows: "/workflows",
  errors: "/errors",
  database: "/database",
  terminal: "/terminal",
  agent: "/agent",
  "agent-env": "/agent-env",
  settings: "/settings",
};

/** Header title translation key per page. */
const PAGE_TITLE_KEY: Record<Page, TranslationKey> = {
  services: "nav.services",
  activity: "nav.activity",
  docker: "nav.docker",
  git: "nav.git",
  github: "nav.github",
  vercel: "nav.vercel",
  workflows: "nav.workflows",
  errors: "nav.errors",
  database: "nav.database",
  terminal: "nav.terminal",
  agent: "pageTitle.agent",
  "agent-env": "pageTitle.agentEnv",
  settings: "nav.settings",
};

// Longest prefix wins so "/agent-env" is matched before "/agent".
const PAGE_PATH_MATCHERS = (Object.entries(PAGE_PATHS) as Array<[Page, string]>)
  .filter(([, path]) => path !== "/")
  .sort(([, a], [, b]) => b.length - a.length);

export function pageFromPath(pathname: string): Page {
  for (const [page, path] of PAGE_PATH_MATCHERS) {
    if (pathname === path) return page;
  }
  return "services";
}

export function sidebarShellClassName(docked = false) {
  return cn(
    "group/sidebar hidden h-full shrink-0 overflow-x-hidden overflow-y-auto border-r border-border bg-card/85 py-4 backdrop-blur transition-[width,padding] duration-200 md:flex md:flex-col",
    docked ? "w-64 px-4" : "w-16 px-2 hover:w-64 hover:px-4",
  );
}

export function navButtonClassName(active: boolean, docked = false) {
  return cn(
    "relative grid h-10 grid-cols-[48px_minmax(0,1fr)] items-center justify-start gap-0 overflow-hidden rounded-md px-0 text-sm font-medium transition-[background-color,color,width] duration-150",
    docked ? "w-full" : "w-12 group-hover/sidebar:w-full",
    active
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : "hover:bg-muted",
  );
}

export function navButtonLabelClassName(docked = false, hasBadge = false) {
  return cn(
    "min-w-0 overflow-hidden text-left text-current transition duration-150 whitespace-pre",
    docked
      ? "translate-x-1 opacity-100"
      : "opacity-0 group-hover/sidebar:translate-x-1 group-hover/sidebar:opacity-100",
    hasBadge ? "pr-10" : "pr-3",
  );
}

export function navButtonIconClassName(docked = false) {
  return cn(
    "flex h-10 w-12 items-center justify-center text-current transition-transform duration-150 [&_svg]:size-5",
    docked ? "translate-x-0" : "-translate-x-px group-hover/sidebar:translate-x-0",
  );
}

export function SidebarCredit({
  docked,
  onToggleDock,
}: {
  docked: boolean;
  onToggleDock?: () => void;
}) {
  return (
    <div
      className={cn(
        "mt-auto flex h-10 min-w-0 items-center overflow-hidden border-t border-border/60 text-[11px] text-muted-foreground transition-[height,opacity,width] duration-150",
        docked
          ? "w-full justify-start opacity-100"
          : "w-12 justify-center group-hover/sidebar:w-full group-hover/sidebar:justify-start group-hover/sidebar:opacity-100",
      )}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-pre transition-[opacity,width] duration-150",
          docked
            ? "flex-1 opacity-100"
            : "w-0 flex-none opacity-0 group-hover/sidebar:w-auto group-hover/sidebar:flex-1 group-hover/sidebar:opacity-100",
        )}
      >
        <span>Made with</span>
        <Heart
          aria-label="love"
          className="size-3 shrink-0 fill-red-500 text-red-500"
        />
        <span>by Robert Wang</span>
        <a
          aria-label="Robert Wang on LinkedIn"
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-[#0A66C2]"
          href="https://www.linkedin.com/in/robert-wang-cs/"
          rel="noopener noreferrer"
          target="_blank"
          title="LinkedIn"
        >
          <svg className="size-3 fill-current" role="img" viewBox="0 0 24 24">
            <title>LinkedIn</title>
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.063 2.063 0 1 1 0-4.126 2.063 2.063 0 0 1 0 4.126zM7.119 20.452H3.554V9h3.565v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z" />
          </svg>
        </a>
      </span>
      <button
        aria-label={docked ? "Undock sidebar" : "Dock sidebar"}
        aria-pressed={docked}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4",
          docked ? "ml-auto bg-muted text-foreground" : "group-hover/sidebar:ml-auto",
        )}
        onClick={onToggleDock}
        title={docked ? "Undock sidebar" : "Dock sidebar"}
        type="button"
      >
        {docked ? <PanelLeftClose /> : <PanelLeftOpen />}
      </button>
    </div>
  );
}

export function AppIdentity({ className }: { className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-baseline gap-1.5">
        <div className="text-sm font-semibold">NoMoreIDE</div>
        <div className="font-mono text-[10px] text-muted-foreground">v{__APP_VERSION__}</div>
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">
        127.0.0.1 console
      </div>
    </div>
  );
}

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
  const [, startTransition] = useTransition();
  const [page, setPage] = useState<Page>(() =>
    syncLocation ? pageFromPath(window.location.pathname) : "services",
  );
  const [data, setData] = useState<DashboardData | null>(null);
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
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      showErrorToast(message);
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
        runActiveRefresh().then(
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
    void refresh().then((ok) => {
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
    const path = PAGE_PATHS[page];
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }, [page, syncLocation]);

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
  const repoScopedPage = page === "git" || page === "github" || page === "vercel";
  const overviewDomain: OverviewDomain | null =
    repoScopedPage && scopeAll ? (page as OverviewDomain) : null;
  const effectiveProject =
    repoScopedPage && !scopeAll ? data?.git.selectedRepository ?? null : activeProject;

  // GitHub identity (repo + credential) is resolved per selected repository, so
  // a project switch invalidates it wherever it is rendered — including the
  // header indicator, which no longer mounts a private copy of the state.
  useEffect(() => {
    if (repoScopeKey === "no-git-repository") return;
    void refreshGitHubToken();
  }, [repoScopeKey]);

  return (
    <AgentProvider>
    <AiContextMenuProvider>
    <SettingsProjectSync
      projectPath={settingsProjectPath}
      selectProject={selectProject}
    />
    <RefreshRegistryProvider value={refreshRegistry}>
    <WorkflowRunProvider onRefresh={() => void refresh({ silent: true })}>
    <WorkflowTriggerProvider>
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
            <AppIdentity
              className={cn(
                "min-w-0 translate-x-1 overflow-hidden transition-opacity duration-200",
                sidebarDocked ? "opacity-100" : "opacity-0 group-hover/sidebar:opacity-100",
              )}
            />
          </div>
          {/* Project scope lives in the header breadcrumb, not here — one
              control for one piece of state. */}
          <nav className="mt-3 flex-1 content-start overflow-y-auto overflow-x-hidden">
            {APP_NAV_SECTIONS.map((section, index) => (
              <div
                className={cn(index > 0 && "mt-2 border-t border-border/60 pt-2")}
                key={section.labelKey}
              >
                <NavSectionLabel docked={sidebarDocked} label={t(section.labelKey)} />
                <div className="grid gap-0.5">
                  {section.items.map((item) => (
                    <NavButton
                      active={page === item.page}
                      badge={item.page === "services" ? runningCount : undefined}
                      docked={sidebarDocked}
                      icon={item.icon}
                      key={item.page}
                      label={t(item.labelKey)}
                      onClick={() => setPage(item.page)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="mb-1 border-t border-border/60 pt-1">
            <NavButton
              active={page === "settings"}
              docked={sidebarDocked}
              icon={<Settings />}
              label={t("nav.settings")}
              onClick={() => setPage("settings")}
            />
          </div>
          <SidebarCredit
            docked={sidebarDocked}
            onToggleDock={() => updateUi({ sidebarDocked: !sidebarDocked })}
          />
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
                {t(PAGE_TITLE_KEY[page])}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              {error ? <Badge variant="danger">{error}</Badge> : null}
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
              </div>
            </div>
          </header>

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

          {loading && !data ? (
            <Alert variant="muted">
              {t("app.loading")}
            </Alert>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
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
              <ActivityView
                data={scopedData}
                onOpenService={(name) => {
                  setFocusService(name);
                  setPage("services");
                }}
                scopeName={activeProject?.name ?? null}
              />
            ) : null}
            {page === "docker" ? <DockerView /> : null}
            {overviewDomain ? (
              <ProjectOverviewGrid
                domain={overviewDomain}
                onEnterProject={() => {
                  setScopeAll(false);
                  void refresh({ silent: true });
                }}
              />
            ) : null}
            {!overviewDomain && data && page === "git" ? (
              <GitReviewView data={data} onRefresh={() => void refresh({ silent: true })} />
            ) : null}
            {!overviewDomain && page === "github" ? <GitHubView key={repoScopeKey} /> : null}
            {!overviewDomain && page === "vercel" ? <VercelView key={repoScopeKey} /> : null}
            {page === "workflows" ? <WorkflowPanel /> : null}
            {page === "agent" ? (
              <AgentView
                focusChanges={changesFocusNonce}
                onOpenAgentEnv={() => setPage("agent-env")}
              />
            ) : null}
            {page === "agent-env" ? <AgentEnvView /> : null}
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
            {page === "terminal" ? <TerminalView /> : null}
            {page === "settings" ? (
              <SettingsView
                activeProject={data?.git.selectedRepository ?? null}
                onNavigate={(nextPage) => setPage(nextPage)}
              />
            ) : null}
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
    </WorkflowTriggerProvider>
    </WorkflowRunProvider>
    </RefreshRegistryProvider>
    </AiContextMenuProvider>
    </AgentProvider>
  );
}

function NavSectionLabel({ docked, label }: { docked: boolean; label: string }) {
  // Fixed height so the collapsed rail doesn't shift when labels fade in.
  return (
    <div className="flex h-5 items-center overflow-hidden px-3">
      <span
        className={cn(
          "whitespace-pre text-[10px] font-semibold uppercase tracking-widest text-muted-foreground transition-opacity duration-150",
          docked ? "opacity-100" : "opacity-0 group-hover/sidebar:opacity-100",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function NavButton({
  active,
  badge,
  docked,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  badge?: number;
  docked: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  // Only render the count badge when there's something to count — a "0" is noise.
  const showBadge = badge !== undefined && badge > 0;
  return (
    <Button
      aria-label={label}
      title={label}
      className={navButtonClassName(active, docked)}
      variant="ghost"
      onClick={onClick}
      type="button"
    >
      <span className={navButtonIconClassName(docked)}>
        {icon}
      </span>
      <span className={navButtonLabelClassName(docked, showBadge)}>{label}</span>
      {badge !== undefined && badge > 0 ? (
        <Badge
          appearance={badge > 0 ? "solid" : "outline"}
          className={cn(
            "min-w-6 justify-center px-1.5 font-mono shadow-none",
            active
              ? // Match the active pill (bg-primary/text-primary-foreground), not
                // the success-green variant. The dark: copies are what actually
                // override the success variant's own dark: classes in dark mode.
                "border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground dark:border-primary-foreground/40 dark:bg-primary-foreground/15 dark:text-primary-foreground"
              : badge > 0
                ? ""
                : "border-border bg-background text-muted-foreground",
            "absolute right-1.5 top-1.5 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none shadow-none group-hover/sidebar:right-2 group-hover/sidebar:top-1/2 group-hover/sidebar:-translate-y-1/2 group-hover/sidebar:text-xs",
            docked && "right-2 top-1/2 -translate-y-1/2 text-xs",
          )}
          size="small"
          variant={badge > 0 ? "success" : "outline"}
        >
          {badge}
        </Badge>
      ) : null}
    </Button>
  );
}

