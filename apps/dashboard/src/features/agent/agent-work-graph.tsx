import { ArrowRight, FolderGit2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "./agent-logos";
import { useAgentDock } from "./chat/agent-context";
import { useObservedAgentSessions } from "./use-observed-agent-sessions";

/** Live workspace → agent → task relationships from the terminal manager. */
export function AgentWorkGraph() {
  const t = useT();
  const observed = useObservedAgentSessions();
  const {
    creating,
    setActiveTaskId,
    setOpen,
    tasks,
    tasksHydrationSettled,
  } = useAgentDock();
  const agentTasks = tasks.filter((task) => task.kind === "agent");
  const running = agentTasks.filter((task) => task.state === "running").length;

  function openTask(id: string) {
    setActiveTaskId(id);
    setOpen(true);
  }

  return (
    <section className="border-b border-border" aria-labelledby="agent-work-graph-heading">
      <header className="flex items-start justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold" id="agent-work-graph-heading">
            {t("agent.workGraph.title")}
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("agent.workGraph.desc")}
          </p>
        </div>
        <Badge appearance="outline" size="small" variant={running ? "success" : "outline"}>
          {t("agent.workGraph.active", { count: running })}
        </Badge>
      </header>

      {!tasksHydrationSettled ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : agentTasks.length === 0 && !creating ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {t("agent.workGraph.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto p-3">
          <div className="min-w-[620px]">
            <div className="mb-1 grid grid-cols-[minmax(150px,0.8fr)_24px_120px_24px_minmax(240px,1.4fr)] px-2 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
              <span>{t("agent.workGraph.workspace")}</span>
              <span />
              <span>{t("agent.workGraph.agent")}</span>
              <span />
              <span>{t("agent.workGraph.task")}</span>
            </div>
            <ul className="divide-y divide-border/60 border-y border-border/60">
              {agentTasks.map((task) => {
                const isRunning = task.state === "running";
                const providerLabel = task.provider === "codex" ? "Codex" : "Claude Code";
                const ProviderLogo = task.provider === "codex" ? CodexLogo : ClaudeLogo;
                return (
                  <li
                    className="grid grid-cols-[minmax(150px,0.8fr)_24px_120px_24px_minmax(240px,1.4fr)] items-center px-2 py-1.5"
                    key={task.id}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-[10px]" title={task.cwd}>
                        {workspaceName(task.cwd)}
                      </span>
                    </div>
                    <Connector />
                    <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-medium">
                      <ProviderLogo className="size-3.5 shrink-0" />
                      <span className="truncate">{providerLabel}</span>
                    </div>
                    <Connector />
                    <button
                      className="group flex min-w-0 items-center gap-2 border border-border/70 bg-background px-2 py-1.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openTask(task.id)}
                      title={t("agent.workGraph.open", { name: task.label ?? providerLabel })}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          isRunning
                            ? "bg-emerald-500"
                            : task.state === "error"
                              ? "bg-destructive"
                              : "bg-muted-foreground/50",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium">
                          {task.label ?? t("dock.taskFallback", { provider: providerLabel })}
                        </span>
                        <span className="block truncate font-mono text-[9px] text-muted-foreground">
                          {task.source?.label ?? stateLabel(task.state, t)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
      <div className="border-t border-border px-3 py-2">
        <h3 className="text-xs font-semibold">{t("agent.workGraph.observed")}</h3>
        <p className="mt-1 text-[11px] text-muted-foreground">{t("agent.workGraph.observedHint")}</p>
      </div>
      {observed.error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{observed.error}</p> : null}
      {!observed.loaded ? <p className="px-3 py-3 text-xs text-muted-foreground">{t("common.loading")}</p> : null}
      {observed.loaded && !observed.error && observed.sessions.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">{t("agent.workGraph.noObserved")}</p>
      ) : null}
      <ul className="max-h-[32rem] overflow-auto divide-y divide-border/60">
        {observed.sessions.map((session) => {
          const updated = Date.parse(session.updatedAt);
          const recent = Number.isFinite(updated) && updated <= observed.observedAt && observed.observedAt - updated < 120_000;
          const Logo = session.provider === "codex" ? CodexLogo : ClaudeLogo;
          return (
            <li key={`${session.provider}:${session.id}`} className="flex flex-wrap items-start gap-3 px-3 py-2">
              <div className="flex w-40 shrink-0 items-center gap-1.5" title={session.cwd}>
                <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-[10px]">{workspaceName(session.cwd)}</span>
              </div>
              <div className="flex w-24 shrink-0 items-center gap-1.5 text-[10px]"><Logo />{session.provider === "codex" ? "Codex" : "Claude Code"}</div>
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-[11px] font-medium" title={session.title}>{session.title}</p>
                <p className="truncate font-mono text-[9px] text-muted-foreground" title={session.cwd}>{session.cwd}</p>
              </div>
              <div className="text-right text-[10px]">
                <span className={recent ? "text-sky-600" : "text-muted-foreground"}>{t(recent ? "agent.workGraph.recentActivity" : "agent.workGraph.lastObserved")}</span>
                <time dateTime={session.updatedAt} className="block text-[9px] text-muted-foreground">{Number.isFinite(updated) ? new Date(updated).toLocaleString() : "—"}</time>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Connector() {
  return (
    <span className="flex items-center text-border" aria-hidden="true">
      <span className="h-px flex-1 bg-current" />
      <ArrowRight className="-ml-0.5 size-3" />
    </span>
  );
}

function workspaceName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || cwd;
}

function stateLabel(
  state: "idle" | "running" | "exited" | "error",
  t: ReturnType<typeof useT>,
): string {
  if (state === "running") return t("agent.workGraph.running");
  if (state === "error") return t("agent.workGraph.failed");
  return t("agent.workGraph.finished");
}
