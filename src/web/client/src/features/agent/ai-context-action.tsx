import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Database, GitBranch, Inbox, SendHorizontal, Server } from "lucide-react";
import {
  headerActionClassName,
  headerActionIconClassName,
  headerActionLabelClassName,
} from "@/components/header-action";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getErrorIncidents,
  listDatabases,
  type DashboardData,
  type DatabaseConnection,
  type ErrorIncident,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ComposerDialog } from "../services/service-form/composer-dialog";
import { StateBadge } from "../services/service-list";
import { AgentMark } from "./ai-spark";
import { useAgentDock } from "./chat/agent-context";
import {
  buildAiContextLabel,
  buildAiContextPrompt,
  emptyAiContextSelection,
  hasAiContextSelection,
  type AiContextSelection,
} from "./prompts";

export function AiContextAction({ data }: { data: DashboardData }) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<AiContextSelection>(() => emptyAiContextSelection());
  const [note, setNote] = useState("");
  const [databases, setDatabases] = useState<DatabaseConnection[]>([]);
  const [incidents, setIncidents] = useState<ErrorIncident[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { sendToAgent } = useAgentDock();
  const t = useT();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadError(null);
    void Promise.allSettled([listDatabases(), getErrorIncidents(20)]).then((results) => {
      if (!active) return;
      const [databaseResult, incidentResult] = results;
      if (databaseResult.status === "fulfilled") {
        setDatabases(databaseResult.value);
      }
      if (incidentResult.status === "fulfilled") {
        setIncidents(incidentResult.value);
      }
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        setLoadError(t("agent.diagnose.loadError"));
      }
    });
    return () => {
      active = false;
    };
  }, [open]);

  const repositories = useMemo(() => repositoryOptions(data), [data]);
  const canSend = hasAiContextSelection(selection);
  const selectedCount = useMemo(
    () =>
      selection.serviceNames.length +
      selection.databaseNames.length +
      selection.errorIds.length +
      selection.repositoryPaths.length,
    [selection],
  );

  function toggleArrayValue<T extends string | number>(
    key: "serviceNames" | "databaseNames" | "errorIds" | "repositoryPaths",
    value: T,
  ) {
    setSelection((current) => {
      const values = current[key] as T[];
      const nextValues = values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value];
      return { ...current, [key]: nextValues };
    });
  }

  function sendContext() {
    if (!canSend) return;
    sendToAgent({
      prompt: buildAiContextPrompt({
        dashboard: data,
        databases,
        incidents,
        note,
        selection,
      }),
      source: { type: "workspace-context", label: t("agent.diagnose.title") },
      label: buildAiContextLabel({ note, selection }),
    });
    setOpen(false);
    setNote("");
    setSelection(emptyAiContextSelection());
  }

  return (
    <>
      <button
        aria-label={t("agent.diagnose.open")}
        className={headerActionClassName()}
        onClick={() => setOpen(true)}
        title={t("agent.diagnose.open")}
        type="button"
      >
        <span className={headerActionIconClassName()}>
          <AgentMark className="size-4" />
        </span>
        <span className={headerActionLabelClassName()}>{t("agent.diagnose.label")}</span>
      </button>
      {open ? (
        <ComposerDialog
          icon={<AgentMark />}
          onClose={() => setOpen(false)}
          size="xl"
          title={t("agent.diagnose.title")}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{t("agent.diagnose.pick")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("agent.diagnose.pickDesc")}
                </div>
              </div>
              <Badge variant={selectedCount ? "secondary" : "outline"}>
                {t("agent.diagnose.selected", { count: selectedCount })}
              </Badge>
            </div>

            {loadError ? <Alert variant="muted">{loadError}</Alert> : null}

            <div className="grid min-h-0 gap-3 overflow-hidden lg:grid-cols-4">
              <ContextSection
                count={data.config.services.length}
                icon={<Server />}
                title={t("agent.diagnose.services")}
              >
                <div className="grid gap-2">
                  {data.config.services.map((service) => {
                    const selected = selection.serviceNames.includes(service.name);
                    const status = data.runtime.services[service.name];
                    const health = data.health[service.name];
                    return (
                      <ContextTile
                        key={service.name}
                        selected={selected}
                        onClick={() => toggleArrayValue("serviceNames", service.name)}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-semibold">{service.name}</span>
                          <span className="shrink-0">
                            <StateBadge state={status?.state ?? "stopped"} />
                          </span>
                        </span>
                        <span className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                          {service.kind ? <span>{service.kind}</span> : null}
                          {service.port ? <span>:{service.port}</span> : null}
                          {health?.status ? <span>{health.status}</span> : null}
                        </span>
                      </ContextTile>
                    );
                  })}
                </div>
              </ContextSection>

              <ContextSection count={databases.length} icon={<Database />} title={t("agent.diagnose.databases")}>
                {databases.length ? (
                  <div className="grid gap-2">
                    {databases.map((database) => (
                      <ContextTile
                        key={database.name}
                        selected={selection.databaseNames.includes(database.name)}
                        onClick={() => toggleArrayValue("databaseNames", database.name)}
                      >
                        <span className="truncate font-semibold">{database.name}</span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                        {database.engine}
                      </span>
                      </ContextTile>
                    ))}
                  </div>
                ) : (
                  <EmptyContext text={t("agent.diagnose.noDatabases")} />
                )}
              </ContextSection>

              <ContextSection count={incidents.length} icon={<Inbox />} title={t("agent.diagnose.errorInbox")}>
                {incidents.length ? (
                  <div className="grid gap-2">
                    {incidents.map((incident) => (
                      <ContextTile
                        key={incident.id}
                        selected={selection.errorIds.includes(incident.id)}
                        onClick={() => toggleArrayValue("errorIds", incident.id)}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-semibold">
                            {incident.title}
                          </span>
                          <Badge
                            appearance="subtle"
                            size="small"
                            variant={incident.level === "error" ? "danger" : "secondary"}
                          >
                            {incident.level}
                          </Badge>
                        </span>
                        <span className="mt-1 block min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                          {incident.service} x{incident.count}
                        </span>
                      </ContextTile>
                    ))}
                  </div>
                ) : (
                  <EmptyContext text={t("agent.diagnose.noIncidents")} />
                )}
              </ContextSection>

              <ContextSection count={repositories.length} icon={<GitBranch />} title={t("agent.diagnose.gitRepositories")}>
                <div className="grid gap-2">
                  {repositories.map((repository) => {
                    const selected = selection.repositoryPaths.includes(repository.path);
                    const current = repository.path === (data.git.selectedRepository?.path ?? data.git.cwd);
                    const fileCount = current ? (data.git.status?.files.length ?? 0) : undefined;
                    return (
                      <ContextTile
                        key={repository.path}
                        selected={selected}
                        onClick={() => toggleArrayValue("repositoryPaths", repository.path)}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-semibold">
                            {repository.name}
                          </span>
                          {current ? (
                            <Badge className="shrink-0" size="small" variant="outline">
                              {t("agent.current")}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-1 block min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                          {repository.path}
                        </span>
                        {fileCount !== undefined ? (
                          <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                            {fileCount
                              ? t("agent.diagnose.changedFiles", { count: fileCount })
                              : t("agent.diagnose.noChangedFiles")}
                          </span>
                        ) : null}
                      </ContextTile>
                    );
                  })}
                </div>
              </ContextSection>
            </div>

            <label className="block space-y-2">
              <span className="text-sm font-medium">{t("agent.diagnose.extraContext")}</span>
              <textarea
                className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40 focus:ring-2 focus:ring-ring"
                onChange={(event) => setNote(event.target.value)}
                placeholder={t("agent.diagnose.notePlaceholder")}
                value={note}
              />
            </label>

            <div className="flex items-center justify-end gap-2">
              <Button onClick={() => setOpen(false)} type="button" variant="outline">
                {t("common.cancel")}
              </Button>
              <Button className="gap-2" disabled={!canSend} onClick={sendContext} type="button">
                <SendHorizontal className="size-4" />
                {t("common.send")}
              </Button>
            </div>
          </div>
        </ComposerDialog>
      ) : null}
    </>
  );
}

function ContextSection({
  children,
  count,
  icon,
  title,
}: {
  children: ReactNode;
  count: number;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="flex max-h-[min(520px,calc(100vh-18rem))] min-h-0 min-w-0 flex-col space-y-2 rounded-md border border-border bg-background/45 p-3">
      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
        <span className="flex size-6 items-center justify-center rounded-md border border-border bg-background text-muted-foreground [&_svg]:size-3.5">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <Badge className="shrink-0" size="small" variant="outline">
          {count}
        </Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pr-1">{children}</div>
    </section>
  );
}

function ContextTile({
  children,
  onClick,
  selected,
}: {
  children: ReactNode;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "min-h-16 min-w-0 rounded-md border p-3 text-left text-sm transition-colors",
        selected
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-background hover:border-foreground/30 hover:bg-muted/60",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function EmptyContext({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/60 px-3 py-3 text-xs text-muted-foreground">
      {text}
    </div>
  );
}

function repositoryOptions(data: DashboardData): Array<{ name: string; path: string }> {
  if (data.config.gitRepositories.length) return data.config.gitRepositories;
  if (data.git.selectedRepository) return [data.git.selectedRepository];
  return [{ name: data.git.cwd.split("/").pop() ?? "repository", path: data.git.cwd }];
}
