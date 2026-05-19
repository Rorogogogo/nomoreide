import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Plus, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToasts } from "@/components/ui/toast";
import { getServiceLogs, type DashboardData, type LogEntry, type ServiceStatus } from "@/lib/api";
import { DebugTimeline } from "./debug-timeline";
import { EmptyState } from "./empty-state";
import { LogSearchInput, LogViewer, logEntryText } from "./log-viewer";
import { PortsOverview } from "./ports-overview";
import { ComposerDialog, GroupForm, ServiceForm } from "./service-forms";
import { ServiceGroupSection, ServiceRow } from "./service-list";

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
  const stickyBottomRef = useRef(true);
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
  const healthByService = data.health ?? {};
  const hasVisibleServices = data.config.bundles.length > 0 || ungroupedServices.length > 0;
  const normalizedLogQuery = logQuery.trim().toLowerCase();
  const visibleLogs = useMemo(() => {
    if (!normalizedLogQuery) return logs;
    return logs.filter((entry) => logEntryText(entry).toLowerCase().includes(normalizedLogQuery));
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
    const pane = logPaneRef.current;
    if (!pane) return;

    function updateStickiness() {
      if (!pane) return;
      const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      stickyBottomRef.current = distanceFromBottom < 40;
    }

    updateStickiness();
    pane.addEventListener("scroll", updateStickiness, { passive: true });
    return () => pane.removeEventListener("scroll", updateStickiness);
  }, [selectedLogService]);

  useEffect(() => {
    if (!streamLogs) return;
    if (!stickyBottomRef.current) return;
    const pane = logPaneRef.current;
    if (pane) {
      pane.scrollTop = pane.scrollHeight;
    }
  }, [streamLogs, visibleLogs]);

  useEffect(() => {
    stickyBottomRef.current = true;
    const pane = logPaneRef.current;
    if (pane) {
      pane.scrollTop = pane.scrollHeight;
    }
  }, [selectedLogService]);

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
    <>
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
                    aria-haspopup="dialog"
                    onClick={() => setServiceComposer("service")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Plus />
                    Add Service
                  </Button>
                  <Button
                    aria-haspopup="dialog"
                    onClick={() => setServiceComposer("group")}
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
              {hasVisibleServices ? (
                <div className="divide-y divide-border">
                  {data.config.bundles.map((group) => (
                    <ServiceGroupSection
                      group={group}
                      key={group.name}
                      onRefresh={onRefresh}
                      ports={data.ports}
                      allServices={data.config.services}
                      health={healthByService}
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
                            health={healthByService[service.name]}
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
          <DebugTimeline events={data.timeline ?? []} />
        </div>
      </div>
      {serviceComposer ? (
        <ComposerDialog
          icon={serviceComposer === "service" ? <Plus /> : <Box />}
          onClose={() => setServiceComposer(null)}
          title={serviceComposer === "service" ? "Add Service" : "Create Group"}
        >
          {serviceComposer === "service" ? (
            <ServiceForm
              cwd={data.cwd}
              onRefresh={onRefresh}
              onSaved={() => setServiceComposer(null)}
            />
          ) : (
            <GroupForm
              services={ungroupedServices}
              onRefresh={onRefresh}
              onSaved={() => setServiceComposer(null)}
            />
          )}
        </ComposerDialog>
      ) : null}
    </>
  );
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
