import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Box, ChevronLeft, ChevronRight, ExternalLink, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import { useToasts } from "@/components/ui/toast";
import { type DashboardData, type ServiceStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentContextPanel } from "./agent-context-panel";
import { DebugTimeline } from "./debug-timeline";
import { EmptyState } from "./empty-state";
import { HealthSummary } from "./health-summary";
import { PortsOverview } from "./ports-overview";
import { LifecycleActions } from "./service-actions";
import { ServiceDetailPanel } from "./service-detail-panel";
import { ComposerDialog, GroupForm, ServiceForm } from "./service-forms";
import {
  isServiceOn,
  PortEditor,
  ServiceGroupSection,
  ServiceRow,
  serviceUrl,
  StateBadge,
} from "./service-list";

export function ServicesView({
  data,
  onRefresh,
}: {
  data: DashboardData;
  onRefresh: () => Promise<void>;
}) {
  const firstService = data.config.services[0]?.name ?? "";
  const [selectedService, setSelectedService] = useState<string>(firstService);
  const [serviceComposer, setServiceComposer] = useState<"group" | "service" | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [contextOpen, setContextOpen] = useState(false);
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

  useEffect(() => {
    const stillExists = data.config.services.some((service) => service.name === selectedService);
    if (!stillExists && firstService) {
      setSelectedService(firstService);
    }
  }, [data.config.services, firstService, selectedService]);

  const selectedServiceDef = useMemo(
    () => data.config.services.find((service) => service.name === selectedService),
    [data.config.services, selectedService],
  );
  const selectedStatus = selectedService ? data.runtime.services[selectedService] : undefined;
  const selectedHealth = selectedService ? healthByService[selectedService] : undefined;

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

  return (
    <>
      <div
        className={cn(
          "grid h-full min-h-0 overflow-hidden bg-card/85",
          railCollapsed
            ? "lg:grid-cols-[320px_minmax(0,1fr)]"
            : "lg:grid-cols-[320px_minmax(0,1fr)_340px]",
        )}
      >
        <div className="min-h-0 min-w-0 overflow-auto border-r border-border">
          <Card className="min-w-0 rounded-none border-0 border-b border-border bg-transparent">
            <CardHeader className="border-b border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">Services</CardTitle>
                <div className="flex items-center gap-1">
                  <Tooltip label="Add service" side="bottom">
                    <Button
                      aria-haspopup="dialog"
                      aria-label="Add service"
                      className="size-7"
                      onClick={() => setServiceComposer("service")}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Plus />
                    </Button>
                  </Tooltip>
                  <Tooltip label="Create group" side="left">
                    <Button
                      aria-haspopup="dialog"
                      aria-label="Create group"
                      className="size-7"
                      onClick={() => setServiceComposer("group")}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Box />
                    </Button>
                  </Tooltip>
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
                      timeline={data.timeline}
                      selectedService={selectedService}
                      onSelectService={setSelectedService}
                    />
                  ))}
                  {ungroupedServices.length
                    ? (
                        [
                          { key: "local", label: "Local Services" },
                          { key: "docker-compose", label: "Docker Compose" },
                          { key: "ssh", label: "Remote (SSH)" },
                        ] as const
                      ).map(({ key, label }) => {
                        const kindServices = ungroupedServices.filter(
                          (service) => (service.kind ?? "local") === key,
                        );
                        if (kindServices.length === 0) return null;
                        return (
                          <div key={key}>
                            <div className="flex items-center justify-between gap-2 bg-muted/55 px-3 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
                              <span>{label}</span>
                              <span className="text-muted-foreground/80">
                                {kindServices.length}
                              </span>
                            </div>
                            <div className="divide-y divide-border">
                              {kindServices.map((service) => (
                                <ServiceRow
                                  key={service.name}
                                  service={service}
                                  status={data.runtime.services[service.name]}
                                  health={healthByService[service.name]}
                                  ports={data.ports}
                                  onRefresh={onRefresh}
                                  timeline={data.timeline}
                                  selected={selectedService === service.name}
                                  onSelect={() => setSelectedService(service.name)}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })
                    : null}
                </div>
              ) : (
                <EmptyState label="No services registered yet." />
              )}
            </CardContent>
          </Card>

        </div>

        <div className="min-h-0 min-w-0 overflow-auto">
          {selectedServiceDef ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 space-y-2 border-b border-border bg-background/60 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="min-w-0 truncate text-base font-semibold">
                    {selectedServiceDef.name}
                  </h2>
                  <StateBadge state={selectedStatus?.state ?? "stopped"} />
                  {selectedServiceDef.kind && selectedServiceDef.kind !== "local" ? (
                    <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {selectedServiceDef.kind}
                    </span>
                  ) : null}
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <PortEditor service={selectedServiceDef} onRefresh={onRefresh} />
                    {(() => {
                      const openUrl =
                        selectedStatus?.url ??
                        (selectedServiceDef.port ? serviceUrl(selectedServiceDef.port) : undefined);
                      return openUrl ? (
                        <Tooltip label={`Open ${openUrl}`}>
                          <Button
                            aria-label="Open in browser"
                            className="size-7"
                            onClick={() => window.open(openUrl, "_blank", "noopener,noreferrer")}
                            size="icon"
                            type="button"
                            variant="outline"
                          >
                            <ExternalLink />
                          </Button>
                        </Tooltip>
                      ) : null;
                    })()}
                    {selectedHealth?.agentContext ? (
                      <Tooltip label="Copy debug context for an AI agent">
                        <Button
                          aria-label="Copy agent debug context"
                          className="size-7"
                          onClick={() => setContextOpen(true)}
                          size="icon"
                          type="button"
                          variant="outline"
                        >
                          <Bot />
                        </Button>
                      </Tooltip>
                    ) : null}
                    <LifecycleActions
                      active={isServiceOn(selectedStatus?.state)}
                      baseUrl={`/api/services/${encodeURIComponent(selectedServiceDef.name)}`}
                      compact
                      targetLabel={selectedServiceDef.name}
                      onRefresh={onRefresh}
                    />
                    <Tooltip
                      label={railCollapsed ? "Show Ports & Timeline" : "Hide Ports & Timeline"}
                      side="left"
                    >
                      <Button
                        aria-label={railCollapsed ? "Show Ports & Timeline" : "Hide Ports & Timeline"}
                        className="size-7"
                        onClick={() => setRailCollapsed((current) => !current)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        {railCollapsed ? <ChevronLeft /> : <ChevronRight />}
                      </Button>
                    </Tooltip>
                  </div>
                </div>
                {selectedServiceDef.command ? (
                  <div className="truncate font-mono text-[11px] text-muted-foreground" title={selectedServiceDef.command}>
                    $ {selectedServiceDef.command}
                  </div>
                ) : null}
                {selectedServiceDef.cwd ? (
                  <div className="truncate font-mono text-[11px] text-muted-foreground" title={selectedServiceDef.cwd}>
                    {selectedServiceDef.cwd}
                  </div>
                ) : null}
                <HealthSummary health={selectedHealth} />
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <ServiceDetailPanel
                  serviceName={selectedServiceDef.name}
                  status={selectedStatus}
                  health={selectedHealth}
                  timeline={data.timeline ?? []}
                  onRefresh={onRefresh}
                />
              </div>
            </div>
          ) : (
            <EmptyState label="Select a service to see details." />
          )}
        </div>

        {!railCollapsed ? (
          <div className="min-h-0 overflow-auto border-l border-border">
            <PortsOverview ports={data.ports} />
            <DebugTimeline events={data.timeline ?? []} />
          </div>
        ) : null}
      </div>
      {contextOpen && selectedServiceDef && selectedHealth?.agentContext ? (
        <ComposerDialog
          icon={<Bot />}
          onClose={() => setContextOpen(false)}
          title={`Agent context — ${selectedServiceDef.name}`}
        >
          <div className="p-4">
            <AgentContextPanel context={selectedHealth.agentContext} />
          </div>
        </ComposerDialog>
      ) : null}
      {serviceComposer ? (
        <ComposerDialog
          icon={serviceComposer === "service" ? <Plus /> : <Box />}
          onClose={() => setServiceComposer(null)}
          size={serviceComposer === "service" ? "lg" : "md"}
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
