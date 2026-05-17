import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  GitBranch,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Server,
  TerminalSquare,
} from "lucide-react";
import { getDashboard, type DashboardData } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ServicesView } from "@/features/services/services-view";
import { GitReviewView } from "@/features/git/git-review-view";
import { RepositorySelector } from "@/features/git/repository-selector";
import { BranchControls } from "@/features/git/branch-controls";
import { useToasts } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type Page = "services" | "git";

export function App() {
  const [page, setPage] = useState<Page>(() =>
    window.location.pathname.startsWith("/git") ? "git" : "services",
  );
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return window.localStorage.getItem("nomoreide:sidebar") === "collapsed";
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
    const path = page === "git" ? "/git" : "/";
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }, [page]);

  useEffect(() => {
    window.localStorage.setItem(
      "nomoreide:sidebar",
      sidebarCollapsed ? "collapsed" : "expanded",
    );
  }, [sidebarCollapsed]);

  const runningCount = useMemo(
    () =>
      data
        ? Object.values(data.runtime.services).filter((service) => service.state === "running")
            .length
        : 0,
    [data],
  );

  return (
    <div className="h-screen overflow-hidden">
      <div className="mx-auto flex h-screen max-w-[1500px]">
        <aside
          className={cn(
            "hidden h-screen shrink-0 overflow-auto border-r border-border bg-card/85 px-4 py-5 backdrop-blur transition-[width] duration-200 md:block",
            sidebarCollapsed ? "w-[76px]" : "w-64",
          )}
        >
          <div
            className={cn(
              "flex items-center px-2",
              sidebarCollapsed ? "justify-center" : "gap-3",
            )}
          >
            <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <TerminalSquare className="size-5" />
            </div>
            <div className={cn("min-w-0", sidebarCollapsed && "hidden")}>
              <div className="text-sm font-semibold">NoMoreIDE</div>
              <div className="font-mono text-[11px] text-muted-foreground">
                127.0.0.1 console
              </div>
            </div>
            <Button
              aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
              className={cn("ml-auto", sidebarCollapsed && "hidden")}
              size="icon"
              variant="ghost"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              <PanelLeftClose />
            </Button>
          </div>
          <div className={cn("mt-4", !sidebarCollapsed && "hidden")}>
            <Button
              aria-label="Expand navigation"
              className="w-full"
              size="icon"
              variant="ghost"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              <PanelLeftOpen />
            </Button>
          </div>
          <nav className="mt-5 grid gap-1">
            <NavButton
              active={page === "services"}
              badge={runningCount}
              collapsed={sidebarCollapsed}
              icon={<Server />}
              label="Services"
              onClick={() => setPage("services")}
            />
            <NavButton
              active={page === "git"}
              collapsed={sidebarCollapsed}
              icon={<GitBranch />}
              label="Git Review"
              onClick={() => setPage("git")}
            />
          </nav>
        </aside>

        <main
          className="flex h-screen min-w-0 flex-1 flex-col px-0 py-0"
        >
          <header
            className={cn(
              "flex shrink-0 flex-wrap items-center justify-between gap-3 border border-border bg-card/90 px-4 py-3 backdrop-blur",
              "border-x-0 border-t-0 border-b",
            )}
          >
            <div className="flex items-center gap-3">
              <PanelLeft className="size-4 text-muted-foreground md:hidden" />
              <div>
                <h1 className="text-lg font-semibold tracking-tight">
                  {page === "git" ? "Git Review" : "Services"}
                </h1>
                <p className="font-mono text-xs text-muted-foreground">
                  {data?.git.selectedRepository?.name ?? data?.git.cwd ?? "Local workspace"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {error ? <Badge variant="danger">{error}</Badge> : null}
              {data && page === "git" ? (
                <RepositorySelector data={data} onRefresh={refresh} />
              ) : null}
              <Button variant="outline" size="sm" onClick={() => void refresh({ notify: true })}>
                <RefreshCw className={cn(loading && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </header>

          {loading && !data ? (
            <Alert variant="muted">
              Loading NoMoreIDE state...
            </Alert>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            {data && page === "services" ? (
              <ServicesView data={data} onRefresh={refresh} />
            ) : null}
            {data && page === "git" ? (
              <GitReviewView data={data} />
            ) : null}
          </div>
        </main>
      </div>
      {data && page === "git" ? (
        <BranchControls
          branches={data.git.branches}
          currentBranch={data.git.status?.branch || undefined}
          disabled={!data.git.status}
          onRefresh={refresh}
        />
      ) : null}
    </div>
  );
}

function NavButton({
  active,
  badge,
  collapsed,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  badge?: number;
  collapsed: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      title={collapsed ? label : undefined}
      className={cn("w-full", collapsed ? "relative justify-center px-0" : "justify-start")}
      variant={active ? "default" : "ghost"}
      onClick={onClick}
      type="button"
    >
      <span className={cn(collapsed && "[&_svg]:size-4")}>{icon}</span>
      <span className={cn("min-w-0 flex-1 text-left", collapsed && "hidden")}>{label}</span>
      {badge !== undefined ? (
        <Badge
          appearance={badge > 0 ? "solid" : "outline"}
          className={cn(
            "min-w-6 justify-center px-1.5 font-mono shadow-none",
            active
              ? "border-primary-foreground/40 bg-primary-foreground/15 text-primary-foreground"
              : badge > 0
                ? ""
                : "border-border bg-background text-muted-foreground",
            collapsed &&
              "absolute right-1.5 top-1.5 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none shadow-none",
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
