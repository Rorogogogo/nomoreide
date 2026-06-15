import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Bot,
  BookOpen,
  Database,
  GitBranch,
  Heart,
  Inbox,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Server,
  SquareTerminal,
} from "lucide-react";
import { getDashboard, type DashboardData } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import {
  headerActionClassName,
  headerActionIconClassName,
  headerActionLabelClassName,
} from "@/components/header-action";
import { AgentView } from "@/features/agent/agent-view";
import { AiContextAction } from "@/features/agent/ai-context-action";
import { AgentProvider } from "@/features/agent/chat/agent-context";
import { WorkflowRunProvider } from "@/features/workflows/workflow-run-context";
import { AgentDock } from "@/features/agent/chat/agent-dock";
import { DatabaseView } from "@/features/database/database-view";
import { ErrorInboxView } from "@/features/errors/error-inbox-view";
import { ServicesView } from "@/features/services/services-view";
import { RunningStripe } from "@/features/services/running-stripe";
import { TerminalView } from "@/features/terminal/terminal-view";
import { GitReviewView } from "@/features/git/git-review-view";
import { GitHubView } from "@/features/github/github-view";
import { GitHubLogo } from "@/features/github/github-logo";
import { RepositorySelector } from "@/features/git/repository-selector";
import { BranchControls } from "@/features/git/branch-controls";
import { useToasts } from "@/components/ui/toast";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { TauriTitleBar } from "@/components/tauri-titlebar";

type Page =
  | "services"
  | "git"
  | "github"
  | "agent"
  | "errors"
  | "database"
  | "terminal";

export function sidebarShellClassName(docked = false) {
  return cn(
    "group/sidebar hidden h-full shrink-0 overflow-x-hidden overflow-y-auto border-r border-border bg-card/85 py-5 backdrop-blur transition-[width,padding] duration-200 md:flex md:flex-col",
    docked ? "w-64 px-4" : "w-16 px-2 hover:w-64 hover:px-4",
  );
}

export function navButtonClassName(active: boolean, docked = false) {
  return cn(
    "relative grid h-12 grid-cols-[48px_minmax(0,1fr)] items-center justify-start gap-0 overflow-hidden rounded-md px-0 text-[15px] font-medium transition-[background-color,color,width] duration-150",
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
    "flex size-12 items-center justify-center text-current transition-transform duration-150 [&_svg]:size-5",
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
  const [page, setPage] = useState<Page>(() => {
    if (!syncLocation) return "services";
    if (window.location.pathname.startsWith("/agent")) return "agent";
    if (window.location.pathname.startsWith("/errors")) return "errors";
    if (window.location.pathname.startsWith("/database")) return "database";
    if (window.location.pathname.startsWith("/terminal")) return "terminal";
    if (window.location.pathname.startsWith("/github")) return "github";
    if (window.location.pathname.startsWith("/git")) return "git";
    return "services";
  });
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const [sidebarDocked, setSidebarDocked] = useState(() => {
    return window.localStorage.getItem("nomoreide:sidebar-docked") === "true";
  });

  const refresh = useCallback(async (options: { notify?: boolean; silent?: boolean } = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      setData(await getDashboard());
      if (options.notify) {
        showSuccessToast("Dashboard refreshed.");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      showErrorToast(message);
    } finally {
      setLoading(false);
    }
  }, [showErrorToast, showSuccessToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function refreshIfVisible() {
      if (document.visibilityState === "visible") {
        void refresh({ silent: true });
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
  }, [page, refresh]);

  useEffect(() => {
    if (!syncLocation) return;
    const path =
      page === "git"
        ? "/git"
        : page === "github"
          ? "/github"
          : page === "agent"
            ? "/agent"
            : page === "errors"
              ? "/errors"
              : page === "database"
                ? "/database"
                : page === "terminal"
                  ? "/terminal"
                  : "/";
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }, [page, syncLocation]);

  useEffect(() => {
    window.localStorage.setItem("nomoreide:sidebar-docked", String(sidebarDocked));
  }, [sidebarDocked]);

  const runningCount = useMemo(
    () =>
      data
        ? Object.values(data.runtime.services).filter((service) => service.state === "running")
            .length
        : 0,
    [data],
  );
  const githubPageKey =
    data?.git.selectedRepository?.name ?? data?.git.cwd ?? "no-git-repository";

  return (
    <AgentProvider>
    <WorkflowRunProvider onRefresh={() => void refresh({ silent: true })}>
    <div className="flex flex-col h-screen overflow-hidden">
    <TauriTitleBar />
    <div className="flex-1 overflow-hidden pb-9">
      <div className="mx-auto flex h-full max-w-[1500px]">
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
          <nav className="mt-5 grid flex-1 content-start gap-1">
            <NavButton
              active={page === "services"}
              badge={runningCount}
              docked={sidebarDocked}
              icon={<Server />}
              label="Services"
              onClick={() => setPage("services")}
            />
            <NavButton
              active={page === "git"}
              docked={sidebarDocked}
              icon={<GitBranch />}
              label="Git Review"
              onClick={() => setPage("git")}
            />
            <NavButton
              active={page === "github"}
              docked={sidebarDocked}
              icon={<GitHubLogo />}
              label="GitHub"
              onClick={() => setPage("github")}
            />
            <NavButton
              active={page === "errors"}
              docked={sidebarDocked}
              icon={<Inbox />}
              label="Error Inbox"
              onClick={() => setPage("errors")}
            />
            <NavButton
              active={page === "database"}
              docked={sidebarDocked}
              icon={<Database />}
              label="Database"
              onClick={() => setPage("database")}
            />
            <NavButton
              active={page === "terminal"}
              docked={sidebarDocked}
              icon={<SquareTerminal />}
              label="Terminal"
              onClick={() => setPage("terminal")}
            />
            <NavButton
              active={page === "agent"}
              docked={sidebarDocked}
              icon={<Bot />}
              label="Agent"
              onClick={() => setPage("agent")}
            />
          </nav>
          <SidebarCredit
            docked={sidebarDocked}
            onToggleDock={() => setSidebarDocked((docked) => !docked)}
          />
        </aside>

        <main
          className="flex h-full min-w-0 flex-1 flex-col px-0 py-0"
        >
          <header
            className={cn(
              "relative z-40 flex shrink-0 flex-wrap items-center justify-between gap-3 border border-border bg-card/90 px-4 py-3 backdrop-blur",
              "border-x-0 border-t-0 border-b",
            )}
          >
            <div className="flex items-center gap-3">
              <PanelLeft className="size-4 text-muted-foreground md:hidden" />
              <div>
                <h1 className="text-lg font-semibold tracking-tight">
                  {page === "git"
                    ? "Git Review"
                    : page === "github"
                      ? "GitHub"
                      : page === "agent"
                        ? "Agent"
                      : page === "errors"
                        ? "Error Inbox"
                        : page === "database"
                          ? "Database"
                          : page === "terminal"
                            ? "Terminal"
                            : "Services"}
                </h1>
                <p className="font-mono text-xs text-muted-foreground">
                  {data?.git.selectedRepository?.name ?? data?.git.cwd ?? "Local workspace"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {error ? <Badge variant="danger">{error}</Badge> : null}
              {data && (page === "git" || page === "github") ? (
                <RepositorySelector data={data} onRefresh={refresh} />
              ) : null}
              <div
                aria-label="Dashboard quick actions"
                className="flex items-center gap-1 rounded-lg border border-border bg-background p-px"
                role="toolbar"
              >
                <button
                  aria-label="Refresh dashboard"
                  className={headerActionClassName()}
                  onClick={() => void refresh({ notify: true })}
                  title="Refresh dashboard"
                  type="button"
                >
                  <span className={headerActionIconClassName()}>
                    <RefreshCw className={cn(loading && "animate-spin")} />
                  </span>
                  <span className={headerActionLabelClassName()}>Refresh</span>
                </button>
                <ThemeToggle />
                <a
                  aria-label="Open NoMoreIDE documentation"
                  className={headerActionClassName()}
                  href="https://www.nomoreide.com/docs"
                  rel="noreferrer"
                  target="_blank"
                  title="Open NoMoreIDE documentation"
                >
                  <span className={headerActionIconClassName()}>
                    <BookOpen />
                  </span>
                  <span className={headerActionLabelClassName()}>Docs</span>
                </a>
                {data ? <AiContextAction data={data} /> : null}
              </div>
            </div>
          </header>

          {data ? (
            <RunningStripe
              data={data}
              onOpenService={(name) => {
                setFocusService(name);
                setPage("services");
                void refresh({ silent: true });
              }}
            />
          ) : null}

          {loading && !data ? (
            <Alert variant="muted">
              Loading NoMoreIDE state...
            </Alert>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            {data && page === "services" ? (
              <ServicesView
                data={data}
                onRefresh={refresh}
                focusService={focusService}
                onServiceFocused={() => setFocusService(null)}
              />
            ) : null}
            {data && page === "git" ? (
              <GitReviewView data={data} onRefresh={() => void refresh({ silent: true })} />
            ) : null}
            {page === "github" ? <GitHubView key={githubPageKey} /> : null}
            {page === "agent" ? <AgentView /> : null}
            {page === "errors" ? <ErrorInboxView /> : null}
            {page === "database" ? (
              <DatabaseView
                staged={stagedSql}
                onStageConsumed={() => setStagedSql(null)}
              />
            ) : null}
            {page === "terminal" ? <TerminalView /> : null}
          </div>
        </main>
      </div>
      {data && page === "git" ? (
        <BranchControls
          ahead={data.git.status?.ahead ?? 0}
          behind={data.git.status?.behind ?? 0}
          branches={data.git.branches}
          currentBranch={data.git.status?.branch || undefined}
          disabled={!data.git.status}
          onRefresh={refresh}
          upstream={data.git.status?.upstream}
        />
      ) : null}
      <AgentDock
        git={data?.git}
        onGitRefresh={() => void refresh({ silent: true })}
        onOpenAgentPage={page === "agent" ? undefined : () => setPage("agent")}
        onOpenService={(name) => {
          setFocusService(name);
          setPage("services");
          void refresh({ silent: true });
        }}
        onOpenSqlConsole={(connection, sql) => {
          setStagedSql((prev) => ({ connection, sql, nonce: (prev?.nonce ?? 0) + 1 }));
          setPage("database");
        }}
      />
    </div>
    </div>
    </WorkflowRunProvider>
    </AgentProvider>
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
