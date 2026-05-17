import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  Box,
  ChevronDown,
  ExternalLink,
  Network,
  Pencil,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Search,
  Square,
  Terminal,
} from "lucide-react";
import {
  siBun,
  siDeno,
  siDocker,
  siGo,
  siNodedotjs,
  siPython,
  siRust,
  siVite,
  type SimpleIcon,
} from "simple-icons/icons";
import {
  getServiceLogs,
  postForm,
  type DashboardData,
  type LogEntry,
  type PortOverview,
  type ServiceStatus,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useToasts } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { processKindForCommand, type ProcessKind } from "./process-kind";

export function ServicesView({
  data,
  onRefresh,
}: {
  data: DashboardData;
  onRefresh: () => Promise<void>;
}) {
  const firstService = data.config.services[0]?.name ?? "";
  const [selectedLogService, setSelectedLogService] = useState(firstService);
  const [logs, setLogs] = useState<LogEntry[]>(data.logs);
  const [logQuery, setLogQuery] = useState("");
  const [serviceComposer, setServiceComposer] = useState<"group" | "service" | null>(null);
  const [streamLogs, setStreamLogs] = useState(false);
  const logPaneRef = useRef<HTMLDivElement>(null);
  const previousStatesRef = useRef<Record<string, ServiceStatus["state"]>>({});
  const {
    error: showErrorToast,
    message: showMessageToast,
    success: showSuccessToast,
  } = useToasts();
  const groupedServiceNames = useMemo(
    () => new Set(data.config.bundles.flatMap((group) => group.services)),
    [data.config.bundles],
  );
  const serviceGroupNameByService = useMemo(() => {
    const groupNames = new Map<string, string>();
    for (const group of data.config.bundles) {
      for (const serviceName of group.services) {
        if (!groupNames.has(serviceName)) {
          groupNames.set(serviceName, group.name);
        }
      }
    }
    return groupNames;
  }, [data.config.bundles]);
  const ungroupedServices = useMemo(
    () => data.config.services.filter((service) => !groupedServiceNames.has(service.name)),
    [data.config.services, groupedServiceNames],
  );
  const hasVisibleServices = data.config.bundles.length > 0 || ungroupedServices.length > 0;
  const normalizedLogQuery = logQuery.trim().toLowerCase();
  const visibleLogs = useMemo(() => {
    if (!normalizedLogQuery) return logs;
    return logs.filter((entry) =>
      logEntryText(entry).toLowerCase().includes(normalizedLogQuery),
    );
  }, [logs, normalizedLogQuery]);

  useEffect(() => {
    if (!selectedLogService && firstService) {
      setSelectedLogService(firstService);
    }
  }, [firstService, selectedLogService]);

  useEffect(() => {
    if (!selectedLogService) {
      setLogs([]);
      return;
    }

    let active = true;
    void getServiceLogs(selectedLogService)
      .then((nextLogs) => {
        if (active) setLogs(nextLogs);
      })
      .catch(() => {
        if (active) setLogs([]);
      });

    return () => {
      active = false;
    };
  }, [selectedLogService, data.runtime.services]);

  useEffect(() => {
    if (!streamLogs || !selectedLogService) return;

    let active = true;
    const load = async () => {
      try {
        const nextLogs = await getServiceLogs(selectedLogService);
        if (active) setLogs(nextLogs);
      } catch {
        if (active) setLogs([]);
      }
    };

    void load();
    const interval = window.setInterval(load, 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [selectedLogService, streamLogs]);

  useEffect(() => {
    if (!streamLogs) return;
    const pane = logPaneRef.current;
    if (pane) {
      pane.scrollTop = pane.scrollHeight;
    }
  }, [streamLogs, visibleLogs]);

  useEffect(() => {
    const nextStates = Object.fromEntries(
      data.config.services.map((service) => [
        service.name,
        data.runtime.services[service.name]?.state ?? "stopped",
      ]),
    ) as Record<string, ServiceStatus["state"]>;
    const previousStates = previousStatesRef.current;

    if (Object.keys(previousStates).length) {
      const groupTransitions = new Map<string, Map<ServiceStatus["state"], number>>();
      const groupExitCodes = new Map<string, Array<number | null | undefined>>();

      for (const service of data.config.services) {
        const nextState = nextStates[service.name];
        const previousState = previousStates[service.name];
        if (!previousState || previousState === nextState) continue;

        const status = data.runtime.services[service.name];
        const groupName = serviceGroupNameByService.get(service.name);
        if (groupName) {
          const transitions =
            groupTransitions.get(groupName) ?? new Map<ServiceStatus["state"], number>();
          transitions.set(nextState, (transitions.get(nextState) ?? 0) + 1);
          groupTransitions.set(groupName, transitions);

          if (nextState === "exited") {
            const exitCodes = groupExitCodes.get(groupName) ?? [];
            exitCodes.push(status?.exitCode);
            groupExitCodes.set(groupName, exitCodes);
          }
          continue;
        }

        if (nextState === "running") {
          showSuccessToast(`${service.name} is running.`);
        } else if (nextState === "stopped") {
          showMessageToast({ text: `${service.name} stopped.` });
        } else if (nextState === "starting") {
          showMessageToast({ text: `${service.name} is starting.` });
        } else if (nextState === "exited") {
          const exitText =
            status?.exitCode === undefined || status.exitCode === null
              ? ""
              : ` with code ${status.exitCode}`;
          showErrorToast(`${service.name} exited${exitText}.`);
        }
      }

      for (const [groupName, transitions] of groupTransitions) {
        showGroupTransitionToast({
          exitCodes: groupExitCodes.get(groupName) ?? [],
          groupName,
          showErrorToast,
          showMessageToast,
          showSuccessToast,
          transitions,
        });
      }
    }

    previousStatesRef.current = nextStates;
  }, [
    data.config.services,
    data.runtime.services,
    serviceGroupNameByService,
    showErrorToast,
    showMessageToast,
    showSuccessToast,
  ]);

  const logEmptyText = selectedLogService
    ? normalizedLogQuery
      ? `No log lines match "${logQuery.trim()}".`
      : `No logs captured for ${selectedLogService}.`
    : "No services registered.";

  if (streamLogs) {
    return (
      <div className="flex h-full min-h-0 bg-card/85">
        <Card className="flex min-h-0 min-w-0 flex-1 flex-col rounded-none border-0 bg-transparent">
          <CardHeader className="shrink-0 border-b border-border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Streaming Logs</CardTitle>
                <CardDescription className="text-xs">
                  Polling the selected service every second and pinned to latest output.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <LogSearchInput value={logQuery} onChange={setLogQuery} />
                <select
                  className="h-8 max-w-72 rounded-md border border-border bg-background px-2.5 text-xs"
                  disabled={!data.config.services.length}
                  onChange={(event) => setSelectedLogService(event.target.value)}
                  value={selectedLogService}
                >
                  {data.config.services.map((service) => (
                    <option key={service.name} value={service.name}>
                      {service.name}
                    </option>
                  ))}
                </select>
                <Button
                  aria-pressed={streamLogs}
                  className="border-emerald-600 bg-emerald-50 text-emerald-700"
                  onClick={() => setStreamLogs(false)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Radio />
                  Streaming
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 p-0">
            <LogViewer
              containerRef={logPaneRef}
              emptyText={logEmptyText}
              logs={visibleLogs}
              query={logQuery}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 overflow-hidden bg-card/85 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-h-0 min-w-0 overflow-auto">
        <Card className="min-w-0 rounded-none border-0 border-b border-border bg-transparent">
          <CardHeader className="border-b border-border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Services</CardTitle>
                <CardDescription className="text-xs">
                  Grouped services are nested; ungrouped services stay standalone.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  aria-pressed={serviceComposer === "service"}
                  className={cn(
                    serviceComposer === "service" &&
                      "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                  onClick={() =>
                    setServiceComposer((current) => (current === "service" ? null : "service"))
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Plus />
                  Add Service
                </Button>
                <Button
                  aria-pressed={serviceComposer === "group"}
                  className={cn(
                    serviceComposer === "group" &&
                      "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                  onClick={() =>
                    setServiceComposer((current) => (current === "group" ? null : "group"))
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Box />
                  Create Group
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {serviceComposer ? (
              <div className="border-b border-border bg-background/70 p-3">
                {serviceComposer === "service" ? (
                  <ServiceForm
                    cwd={data.cwd}
                    onRefresh={onRefresh}
                    onSaved={() => setServiceComposer(null)}
                  />
                ) : (
                  <GroupForm
                    services={data.config.services}
                    onRefresh={onRefresh}
                    onSaved={() => setServiceComposer(null)}
                  />
                )}
              </div>
            ) : null}
            {hasVisibleServices ? (
              <div className="divide-y divide-border">
                {data.config.bundles.map((group) => (
                  <ServiceGroupSection
                    group={group}
                    key={group.name}
                    onRefresh={onRefresh}
                    ports={data.ports}
                    allServices={data.config.services}
                    services={data.config.services.filter((service) =>
                      group.services.includes(service.name),
                    )}
                    statuses={data.runtime.services}
                  />
                ))}
                {ungroupedServices.length ? (
                  <div>
                    {data.config.bundles.length ? (
                      <div className="bg-muted/55 px-3 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                        Ungrouped Services
                      </div>
                    ) : null}
                    <div className="divide-y divide-border">
                      {ungroupedServices.map((service) => (
                        <ServiceRow
                          key={service.name}
                          service={service}
                          status={data.runtime.services[service.name]}
                          ports={data.ports}
                          onRefresh={onRefresh}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState label="No services registered yet." />
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 rounded-none border-0 bg-transparent">
          <CardHeader className="border-b border-border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Recent Logs</CardTitle>
                <CardDescription className="text-xs">
                  Updates with dashboard refresh. Use Stream for a full-page live view.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <LogSearchInput value={logQuery} onChange={setLogQuery} />
                <select
                  className="h-8 max-w-72 rounded-md border border-border bg-background px-2.5 text-xs"
                  disabled={!data.config.services.length}
                  onChange={(event) => setSelectedLogService(event.target.value)}
                  value={selectedLogService}
                >
                  {data.config.services.map((service) => (
                    <option key={service.name} value={service.name}>
                      {service.name}
                    </option>
                  ))}
                </select>
                <Button
                  aria-pressed={streamLogs}
                  disabled={!selectedLogService}
                  onClick={() => setStreamLogs(true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Radio />
                  Stream
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="min-w-0 p-0">
            <LogViewer
              className="max-h-[320px]"
              containerRef={logPaneRef}
              emptyText={logEmptyText}
              logs={visibleLogs}
              query={logQuery}
            />
          </CardContent>
        </Card>
      </div>

      <div className="min-h-0 overflow-auto border-l border-border">
        <PortsOverview ports={data.ports} />
      </div>
    </div>
  );
}

function ServiceGroupSection({
  allServices,
  group,
  onRefresh,
  ports,
  services,
  statuses,
}: {
  allServices: DashboardData["config"]["services"];
  group: DashboardData["config"]["bundles"][number];
  onRefresh: () => Promise<void>;
  ports: PortOverview[];
  services: DashboardData["config"]["services"];
  statuses: DashboardData["runtime"]["services"];
}) {
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const active = services.some((service) => isServiceOn(statuses[service.name]?.state));

  return (
    <section>
      <div className="grid gap-2 bg-muted/35 px-3 py-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <button
            className="flex max-w-full items-start gap-2 text-left"
            onClick={() => setCollapsed((current) => !current)}
            type="button"
          >
            <ChevronDown
              className={cn(
                "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                collapsed && "-rotate-90",
              )}
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <Badge appearance="subtle" className="shadow-none" size="small" variant="secondary">
                  group
                </Badge>
                <span className="text-sm font-medium">{group.name}</span>
                <Badge variant="secondary">{group.services.length}</Badge>
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {group.services.join(", ")}
              </span>
            </span>
          </button>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            aria-expanded={editing}
            onClick={() => setEditing((current) => !current)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Pencil />
            Edit
          </Button>
          <LifecycleActions
            active={active}
            baseUrl={`/api/bundles/${encodeURIComponent(group.name)}`}
            restartAction={async () => {
              await postForm(`/api/bundles/${encodeURIComponent(group.name)}/stop`, {});
              await postForm(`/api/bundles/${encodeURIComponent(group.name)}/start`, {});
            }}
            targetLabel={`group ${group.name}`}
            onRefresh={onRefresh}
          />
        </div>
      </div>
      {editing ? (
        <div className="border-t border-border bg-background/65 p-3">
          <GroupForm
            initialName={group.name}
            initialServices={group.services}
            onRefresh={onRefresh}
            onSaved={() => setEditing(false)}
            originalName={group.name}
            services={allServices}
            submitLabel="Save Group"
          />
        </div>
      ) : null}
      {collapsed ? null : (
        <div className="divide-y divide-border border-t border-border bg-background/45">
          {services.length ? (
            services.map((service) => (
              <ServiceRow
                key={service.name}
                service={service}
                status={statuses[service.name]}
                ports={ports}
                onRefresh={onRefresh}
              />
            ))
          ) : (
            <Alert variant="muted" className="m-4">
              This group does not match any registered services.
            </Alert>
          )}
        </div>
      )}
    </section>
  );
}

function LogSearchInput({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="relative block">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Search logs"
        className="h-8 w-44 pl-7 text-xs"
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search logs"
        value={value}
      />
    </label>
  );
}

function LogViewer({
  className,
  containerRef,
  emptyText,
  logs,
  query,
}: {
  className?: string;
  containerRef: RefObject<HTMLDivElement | null>;
  emptyText: string;
  logs: LogEntry[];
  query: string;
}) {
  return (
    <div
      className={cn(
        "h-full max-w-full overflow-auto font-mono text-[11px] leading-5",
        className,
      )}
      ref={containerRef}
      role="log"
    >
      {logs.length ? (
        logs.map((entry, index) => (
          <div
            className={cn(
              "grid min-w-max grid-cols-[168px_minmax(420px,1fr)] gap-2 border-b border-border/45 px-3 py-0.5",
              entry.stream === "stderr"
                ? "bg-red-50/70 text-red-800"
                : "bg-emerald-50/35 text-zinc-800",
            )}
            key={`${entry.timestamp}-${entry.stream}-${index}`}
          >
            <span className="text-muted-foreground">{entry.timestamp}</span>
            <span className="whitespace-pre-wrap break-words">
              {entry.stream === "stderr" ? (
                <span className="mr-2 rounded bg-red-100 px-1 font-semibold uppercase text-red-700">
                  stderr
                </span>
              ) : null}
              {highlightText(entry.text, query)}
            </span>
          </div>
        ))
      ) : (
        <div className="p-3 text-muted-foreground">{emptyText}</div>
      )}
    </div>
  );
}

function logEntryText(entry: LogEntry): string {
  return `${entry.timestamp} ${entry.stream} ${entry.text}`;
}

function highlightText(text: string, query: string): ReactNode {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = lowerText.indexOf(lowerQuery);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    const nextCursor = matchIndex + trimmedQuery.length;
    parts.push(
      <mark className="rounded bg-amber-200 px-0.5 text-amber-950" key={`${matchIndex}-${nextCursor}`}>
        {text.slice(matchIndex, nextCursor)}
      </mark>,
    );
    cursor = nextCursor;
    matchIndex = lowerText.indexOf(lowerQuery, cursor);
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts;
}

function showGroupTransitionToast({
  exitCodes,
  groupName,
  showErrorToast,
  showMessageToast,
  showSuccessToast,
  transitions,
}: {
  exitCodes: Array<number | null | undefined>;
  groupName: string;
  showErrorToast: (text: string) => void;
  showMessageToast: (message: { text: string }) => void;
  showSuccessToast: (text: string) => void;
  transitions: Map<ServiceStatus["state"], number>;
}) {
  if (transitions.size === 1) {
    const [state] = transitions.keys();
    if (state === "running") {
      showSuccessToast(`${groupName} group is running.`);
    } else if (state === "stopped") {
      showMessageToast({ text: `${groupName} group stopped.` });
    } else if (state === "starting") {
      showMessageToast({ text: `${groupName} group is starting.` });
    } else if (state === "exited") {
      const knownCodes = exitCodes.filter((code) => code !== undefined && code !== null);
      const exitText = knownCodes.length ? ` with code ${knownCodes.join(", ")}` : "";
      showErrorToast(`${groupName} group exited${exitText}.`);
    }
    return;
  }

  const summary = [...transitions.entries()]
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
  const text = `${groupName} group updated: ${summary}.`;
  if (transitions.has("exited")) {
    showErrorToast(text);
  } else {
    showMessageToast({ text });
  }
}

function CollapsiblePanel({
  children,
  description,
  icon,
  title,
}: {
  children: ReactNode;
  description: string;
  icon: ReactNode;
  title: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card className="rounded-none border-0 border-b border-border bg-transparent">
      <button
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{title}</span>
            <span className="block truncate text-xs text-muted-foreground">{description}</span>
          </span>
        </span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open ? <CardContent className="border-t border-border p-3">{children}</CardContent> : null}
    </Card>
  );
}

function ServiceRow({
  service,
  status,
  ports,
  onRefresh,
}: {
  service: DashboardData["config"]["services"][number];
  status?: ServiceStatus;
  ports: PortOverview[];
  onRefresh: () => Promise<void>;
}) {
  const state = status?.state ?? "stopped";
  const active = isServiceOn(state);
  const openUrl = status?.url ?? (service.port ? serviceUrl(service.port) : undefined);
  const configuredPort = service.port
    ? ports.find((port) => port.port === service.port)
    : undefined;
  const detectedPort = portFromUrl(status?.url);
  const detectedPortOverview = detectedPort
    ? ports.find((port) => port.port === detectedPort)
    : undefined;
  return (
    <div className="grid gap-2 px-3 py-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <ProcessBadge command={service.command} />
          <span className="text-sm font-medium">{service.name}</span>
          <StateBadge state={state} />
          {service.port ? <Badge variant="outline">:{service.port}</Badge> : null}
          {configuredPort ? <PortStateBadge port={configuredPort} compact /> : null}
          {detectedPortOverview && detectedPortOverview.port !== service.port ? (
            <Badge variant="success">actual :{detectedPortOverview.port}</Badge>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {service.command}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{service.cwd}</div>
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        <PortEditor service={service} onRefresh={onRefresh} />
        {openUrl ? (
          <Button
            onClick={() => window.open(openUrl, "_blank", "noopener,noreferrer")}
            size="sm"
            type="button"
            variant="outline"
            title={openUrl}
          >
            <ExternalLink />
            Open
          </Button>
        ) : null}
        <LifecycleActions
          active={active}
          baseUrl={`/api/services/${encodeURIComponent(service.name)}`}
          targetLabel={service.name}
          onRefresh={onRefresh}
        />
      </div>
    </div>
  );
}

function isServiceOn(state: ServiceStatus["state"] | undefined): boolean {
  return state === "running" || state === "starting";
}

function PortsOverview({ ports }: { ports: PortOverview[] }) {
  const occupiedCount = ports.filter((port) => port.state === "occupied").length;
  const managedCount = ports.filter((port) => port.state === "managed").length;

  return (
    <Card className="rounded-none border-0 border-b border-border bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <CardTitle className="flex items-center gap-2">
          <Network className="size-3.5" />
          Ports
        </CardTitle>
        <CardDescription className="text-xs">
          {managedCount} managed, {occupiedCount} occupied by other
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {ports.length ? (
          <div className="divide-y divide-border">
            {ports.map((port) => (
              <div
                className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2"
                key={port.port}
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs">:{port.port}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {port.services.join(", ") || "Unassigned"}
                  </div>
                  {port.urls[0] ? (
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {port.urls[0]}
                    </div>
                  ) : null}
                </div>
                <PortStateBadge port={port} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label="No configured ports yet." />
        )}
      </CardContent>
    </Card>
  );
}

function PortStateBadge({
  compact,
  port,
}: {
  compact?: boolean;
  port: PortOverview;
}) {
  const label =
    port.state === "managed"
      ? "managed"
      : port.state === "occupied"
        ? "occupied by other"
        : "available";
  const variant =
    port.state === "managed"
      ? "success"
      : port.state === "occupied"
        ? "warning"
        : "outline";

  return (
    <Badge className={cn(compact && "max-w-36 truncate")} variant={variant}>
      {label}
    </Badge>
  );
}

function PortEditor({
  service,
  onRefresh,
}: {
  service: DashboardData["config"]["services"][number];
  onRefresh: () => Promise<void>;
}) {
  const [port, setPort] = useState(service.port ? String(service.port) : "");
  const [busy, setBusy] = useState(false);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const dirty = port.trim() !== (service.port ? String(service.port) : "");

  useEffect(() => {
    setPort(service.port ? String(service.port) : "");
  }, [service.port]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await postForm("/api/services", {
        name: service.name,
        command: service.command,
        cwd: service.cwd,
        port,
        description: service.description,
      });
      showSuccessToast(`Port saved for ${service.name}.`);
      await onRefresh();
    } catch (caught) {
      showErrorToast(actionErrorMessage("Save port", service.name, caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex items-center gap-1.5" onSubmit={submit}>
      <Input
        aria-label={`Port for ${service.name}`}
        className="h-8 w-20 font-mono text-xs"
        inputMode="numeric"
        min={1}
        max={65535}
        onChange={(event) => setPort(event.target.value)}
        placeholder="port"
        type="number"
        value={port}
      />
      <Button
        aria-label={`Save port for ${service.name}`}
        disabled={busy || !dirty}
        className="size-8"
        size="icon"
        title="Save port"
        type="submit"
        variant="outline"
      >
        <Save />
      </Button>
    </form>
  );
}

function serviceUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : undefined;
  } catch {
    return undefined;
  }
}

function StateBadge({ state }: { state: ServiceStatus["state"] }) {
  return (
    <Badge
      variant={
        state === "running"
          ? "success"
          : state === "exited"
            ? "danger"
            : state === "starting"
              ? "warning"
              : "outline"
      }
      className={cn(state === "running" && "font-mono")}
    >
      {state}
    </Badge>
  );
}

function ProcessBadge({
  command,
  compact,
}: {
  command: string;
  compact?: boolean;
}) {
  const process = processKindForCommand(command);
  const icon = processBadgeIcon[process.kind];

  return (
    <span
      aria-label={`${process.label} process`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border bg-white shadow-sm",
        compact ? "size-6" : "size-7",
        icon ? "border-zinc-200" : "border-zinc-300 bg-zinc-100 text-zinc-700",
      )}
      style={icon ? { color: `#${icon.hex}` } : undefined}
      title={process.label}
    >
      {icon ? (
        <svg
          aria-hidden="true"
          className={compact ? "size-3.5" : "size-4"}
          fill="currentColor"
          role="img"
          viewBox="0 0 24 24"
        >
          <path d={icon.path} />
        </svg>
      ) : (
        <Terminal className={compact ? "size-3.5" : "size-4"} />
      )}
    </span>
  );
}

const processBadgeIcon: Record<ProcessKind, SimpleIcon | null> = {
  bun: siBun,
  cargo: siRust,
  deno: siDeno,
  docker: siDocker,
  generic: null,
  go: siGo,
  node: siNodedotjs,
  python: siPython,
  rust: siRust,
  vite: siVite,
};

function LifecycleActions({
  active,
  baseUrl,
  onRefresh,
  restartAction,
  targetLabel,
}: {
  active: boolean;
  baseUrl: string;
  onRefresh: () => Promise<void>;
  restartAction?: () => Promise<void>;
  targetLabel: string;
}) {
  if (!active) {
    return (
      <ActionButton
        intent="start"
        icon={<Play />}
        label="Start"
        targetLabel={targetLabel}
        url={`${baseUrl}/start`}
        onRefresh={onRefresh}
      />
    );
  }

  return (
    <>
      <ActionButton
        intent="restart"
        icon={<RotateCcw />}
        label="Restart"
        action={restartAction}
        targetLabel={targetLabel}
        url={`${baseUrl}/restart`}
        onRefresh={onRefresh}
      />
      <ActionButton
        intent="stop"
        icon={<Square />}
        label="Stop"
        targetLabel={targetLabel}
        url={`${baseUrl}/stop`}
        onRefresh={onRefresh}
      />
    </>
  );
}

function ActionButton({
  action,
  intent = "neutral",
  icon,
  label,
  targetLabel,
  url,
  onRefresh,
}: {
  action?: () => Promise<void>;
  intent?: "neutral" | "restart" | "start" | "stop";
  icon: ReactNode;
  label: string;
  targetLabel: string;
  url: string;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  return (
    <Button
      className={actionButtonClass[intent]}
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          if (action) {
            await action();
          } else {
            await postForm(url, {});
          }
          showSuccessToast(`${label} requested for ${targetLabel}.`);
          await onRefresh();
        } catch (caught) {
          showErrorToast(actionErrorMessage(label, targetLabel, caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      {icon}
      {label}
    </Button>
  );
}

const actionButtonClass = {
  neutral: "",
  restart: "border-amber-600 bg-amber-600 text-white hover:bg-amber-700",
  start: "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700",
  stop: "border-red-600 bg-red-600 text-white hover:bg-red-700",
} satisfies Record<"neutral" | "restart" | "start" | "stop", string>;

function actionErrorMessage(label: string, targetLabel: string, caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return `${label} failed for ${targetLabel}: ${message}`;
}

function ServiceForm({
  cwd,
  onRefresh,
  onSaved,
}: {
  cwd: string;
  onRefresh: () => Promise<void>;
  onSaved?: () => void;
}) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "");
    try {
      await postForm("/api/services", {
        name,
        command: String(form.get("command") ?? ""),
        cwd: String(form.get("cwd") ?? ""),
        port: String(form.get("port") ?? ""),
        description: String(form.get("description") ?? ""),
      });
      formElement.reset();
      showSuccessToast(`${name} added.`);
      await onRefresh();
      onSaved?.();
    } catch (caught) {
      showErrorToast(actionErrorMessage("Add service", name || "service", caught));
    }
  }

  return (
    <form className="grid gap-2.5" onSubmit={submit}>
      <Label>
        Name
        <Input className="h-8 text-sm" name="name" placeholder="backend" required />
      </Label>
      <Label>
        Command
        <Input className="h-8 text-sm" name="command" placeholder="npm run dev" required />
      </Label>
      <Label>
        Working Directory
        <Input className="h-8 text-sm" name="cwd" defaultValue={cwd} required />
      </Label>
      <Label>
        Port
        <Input className="h-8 text-sm" name="port" inputMode="numeric" placeholder="3001" />
      </Label>
      <Label>
        Description
        <Input className="h-8 text-sm" name="description" placeholder="API server" />
      </Label>
      <Button className="h-8" type="submit">Add Service</Button>
    </form>
  );
}

function GroupForm({
  initialName = "",
  initialServices = [],
  onSaved,
  onRefresh,
  originalName,
  services,
  submitLabel = "Save Group",
}: {
  initialName?: string;
  initialServices?: string[];
  onSaved?: () => void;
  onRefresh: () => Promise<void>;
  originalName?: string;
  services: DashboardData["config"]["services"];
  submitLabel?: string;
}) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "");
    const selectedServices = form
      .getAll("services")
      .map((service) => String(service))
      .filter(Boolean);
    try {
      await postForm("/api/bundles", {
        name,
        originalName,
        services: selectedServices.join(","),
      });
      formElement.reset();
      showSuccessToast(`${name} group saved.`);
      await onRefresh();
      onSaved?.();
    } catch (caught) {
      showErrorToast(actionErrorMessage("Save group", name || "group", caught));
    }
  }

  return (
    <form className="grid gap-2.5" onSubmit={submit}>
      <Label>
        Group name
        <Input
          className="h-8 text-sm"
          defaultValue={initialName}
          name="name"
          placeholder="full-stack"
          required
        />
      </Label>
      <fieldset className="grid gap-1.5">
        <legend className="text-xs font-medium">Services</legend>
        {services.length ? (
          services.map((service) => (
            <label
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
              key={service.name}
            >
              <input
                className="size-4 accent-primary"
                defaultChecked={initialServices.includes(service.name)}
                name="services"
                type="checkbox"
                value={service.name}
              />
              <ProcessBadge command={service.command} compact />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{service.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {service.command}
                </span>
              </span>
            </label>
          ))
        ) : (
          <Alert variant="muted">Add services before creating a group.</Alert>
        )}
      </fieldset>
      <Button className="h-8" disabled={!services.length} type="submit">
        {submitLabel}
      </Button>
    </form>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <Alert variant="muted" className="m-4 text-center">
      {label}
    </Alert>
  );
}
