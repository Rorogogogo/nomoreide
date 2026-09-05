import { ArrowRight, FolderGit2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "./agent-logos";
import { useAgentDock } from "./chat/agent-context";

/** Live workspace → agent → task relationships from the terminal manager. */
export function AgentWorkGraph() {
  const t = useT();
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
