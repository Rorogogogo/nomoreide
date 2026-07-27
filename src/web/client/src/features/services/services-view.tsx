import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Pencil,
  Plus,
  ScrollText,
  Trash2,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useToasts } from "@/components/ui/toast";
import {
  addServiceToBundle,
  deleteService,
  removeServiceFromBundle,
  type DashboardData,
  type ServiceStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { openExternal } from "@/lib/tauri";
import { useT, type Translate } from "@/lib/i18n";
import { DebugTimeline } from "./debug-timeline";
import { DependencyGraph } from "./dependency-graph";
import { EmptyState } from "./empty-state";
import { FirstRunGuide } from "./first-run-guide";
import { HealthSummary } from "./health-summary";
import { PortsOverview } from "./ports-overview";
import { LifecycleActions } from "./service-actions";
import { MultiLogView } from "./multi-log-view";
import { ServiceDetailPanel } from "./service-detail-panel";
import { ComposerDialog, GroupForm, ServiceForm } from "./service-forms";
import { unassignedServices } from "./project-scope";
import { OnboardDialog } from "../onboard/onboard-dialog";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
import {
  buildGroupServicesPrompt,
  buildServiceDebugPrompt,
  SETUP_SERVICE_PROMPT,
} from "../agent/prompts";
import {
  isServiceOn,
  SERVICE_DRAG_TYPE,
  ServiceGroupSection,
  ServiceRow,
  serviceUrl,
  StateBadge,
} from "./service-list";

export function ServicesView({
  data,
  onRefresh,
  focusService,
  onServiceFocused,
  scopeName,
}: {
  data: DashboardData;
  onRefresh: () => Promise<void>;
  /** When set (e.g. from the dock's "Open" shortcut), select this service. */
  focusService?: string | null;
  onServiceFocused?: () => void;
  /** Project the data was scoped to, or null for the all-projects view. */
  scopeName?: string | null;
}) {
  const t = useT();
  const firstService = data.config.services[0]?.name ?? "";
  const [selectedService, setSelectedService] = useState<string>(firstService);
  const [serviceComposer, setServiceComposer] = useState<"group" | "service" | null>(null);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const { sendToAgent, startOnboard } = useAgentDock();
  const [multiLogOpen, setMultiLogOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [ungroupedDragOver, setUngroupedDragOver] = useState(false);
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
  const serviceNames = useMemo(
    () => data.config.services.map((service) => service.name),
    [data.config.services],
  );
  const unassigned = useMemo(
    () => unassignedServices(data.config.services, data.config.gitRepositories),
    [data.config.services, data.config.gitRepositories],
  );
  const hasDependencies = useMemo(
    () => data.config.services.some((service) => (service.dependsOn?.length ?? 0) > 0),
    [data.config.services],
  );
  const healthByService = data.health ?? {};
  const hasVisibleServices = data.config.bundles.length > 0 || ungroupedServices.length > 0;

  useEffect(() => {
    const stillExists = data.config.services.some((service) => service.name === selectedService);
    if (!stillExists && firstService) {
      setSelectedService(firstService);
    }
  }, [data.config.services, firstService, selectedService]);

  // The dock's "Open" shortcut asks us to focus a freshly added service. Wait
  // until it shows up in the config (registration + the next poll), then select
  // it and clear the request so manual selection isn't fought afterwards.
  useEffect(() => {
    if (!focusService) return;
    if (data.config.services.some((service) => service.name === focusService)) {
      setSelectedService(focusService);
      onServiceFocused?.();
    }
  }, [focusService, data.config.services, onServiceFocused]);

  const selectedServiceDef = useMemo(
    () => data.config.services.find((service) => service.name === selectedService),
    [data.config.services, selectedService],
  );
  const selectedStatus = selectedService ? data.runtime.services[selectedService] : undefined;
  const selectedHealth = selectedService ? healthByService[selectedService] : undefined;

  async function addToGroup(
    group: DashboardData["config"]["bundles"][number],
    serviceName: string,
  ) {
    if (group.services.includes(serviceName)) return;
    try {
      await addServiceToBundle(group.name, group.services, serviceName);
      showSuccessToast(t("services.toast.addedToGroup", { service: serviceName, group: group.name }));
      await onRefresh();
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function deleteSelected() {
    if (!selectedServiceDef) return;
    if (isServiceOn(selectedStatus?.state)) {
      showErrorToast(t("services.toast.stopBeforeDelete", { name: selectedServiceDef.name }));
      return;
    }
    if (!window.confirm(t("services.confirmDelete", { name: selectedServiceDef.name }))) {
      return;
    }
    try {
      await deleteService(selectedServiceDef.name);
      showSuccessToast(t("services.toast.deleted", { name: selectedServiceDef.name }));
      await onRefresh();
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function removeFromGroups(serviceName: string) {
    const owningGroups = data.config.bundles.filter((bundle) =>
      bundle.services.includes(serviceName),
    );
    if (owningGroups.length === 0) return;
    try {
      for (const group of owningGroups) {
        await removeServiceFromBundle(group.name, group.services, serviceName);
      }
      showMessageToast({
        text: t("services.toast.removedFromGroups", {
          service: serviceName,
          groups: owningGroups.map((group) => group.name).join(", "),
        }),
      });
      await onRefresh();
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    }
  }

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
          showSuccessToast(t("services.toast.running", { name: service.name }));
        } else if (nextState === "stopped") {
          showMessageToast({ text: t("services.toast.stopped", { name: service.name }) });
        } else if (nextState === "starting") {
          showMessageToast({ text: t("services.toast.starting", { name: service.name }) });
        } else if (nextState === "exited") {
          showErrorToast(
            status?.exitCode === undefined || status.exitCode === null
              ? t("services.toast.exited", { name: service.name })
              : t("services.toast.exitedWithCode", { name: service.name, code: status.exitCode }),
          );
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
          t,
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

  const hasServices = data.config.services.length > 0;

  return (
    <>
      {!hasServices && scopeName ? (
        // A scoped project with no services isn't a first run — the machine
        // may run plenty elsewhere. Offer the way back out instead.
        <div className="flex h-full items-center justify-center p-8 text-center">
          <div className="max-w-sm text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              No services in {scopeName}
            </p>
            <p className="mt-1 text-xs">
              Services whose working directory lives under this project appear
              here. Switch to All projects in the sidebar to see everything.
            </p>
          </div>
        </div>
      ) : !hasServices ? (
        <FirstRunGuide
          onOnboardRepo={() => setOnboardOpen(true)}
          onOnboardWithAi={startOnboard}
          onCreateService={() => setServiceComposer("service")}
          onCreateWithAi={() =>
            sendToAgent({
              prompt: SETUP_SERVICE_PROMPT,
              source: { type: "service-setup", label: "Add a service" },
              label: "Help me add a new service, one step at a time.",
            })
          }
        />
      ) : (
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
                <CardTitle className="text-sm">{t("services.title")}</CardTitle>
                <div className="flex items-center gap-1">
                  <Button
                    aria-haspopup="dialog"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={() => setGraphOpen(true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Workflow className="size-3.5" />
                    {t("services.graph")}
                  </Button>
                  <Button
                    aria-haspopup="dialog"
                    className="h-7 gap-1.5 px-2 text-xs"
                    onClick={() => setMultiLogOpen(true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <ScrollText className="size-3.5" />
                    {t("services.logs")}
                  </Button>
                  <AddMenu
                    onCreateGroup={() => setServiceComposer("group")}
                    onCreateService={() => setServiceComposer("service")}
                    onOnboardRepo={() => setOnboardOpen(true)}
                    onOnboardWithAi={startOnboard}
                    canGroupWithAi={ungroupedServices.length > 1}
                    onCreateWithAi={() =>
                      sendToAgent({
                        prompt: SETUP_SERVICE_PROMPT,
                        source: { type: "service-setup", label: "Add a service" },
                        label: "Help me add a new service, one step at a time.",
                      })
                    }
                    onGroupWithAi={() =>
                      sendToAgent({
                        prompt: buildGroupServicesPrompt(ungroupedServices),
                        source: { type: "group-services", label: "Group services" },
                        label: "Propose how to group my ungrouped services.",
                      })
                    }
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {/* Only in the all-projects view: a service belonging to no
                  project is invisible from every scoped view, so this is the
                  one place it can be found and assigned. */}
              {!scopeName && unassigned.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">
                    {t("services.unassignedNotice", { count: unassigned.length })}
                  </span>
                  {unassigned.map((service) => (
                    <Button
                      className="h-6 px-2 text-[11px]"
                      key={service.name}
                      onClick={() => {
                        setSelectedService(service.name);
                        setEditOpen(true);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {service.name}
                    </Button>
                  ))}
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
                      health={healthByService}
                      services={data.config.services.filter((service) =>
                        group.services.includes(service.name),
                      )}
                      statuses={data.runtime.services}
                      timeline={data.timeline}
                      selectedService={selectedService}
                      onSelectService={setSelectedService}
                      onDropService={(serviceName) => void addToGroup(group, serviceName)}
                    />
                  ))}
                  {ungroupedServices.length ? (
                    <div
                      className={cn(
                        "transition-colors",
                        ungroupedDragOver &&
                          "bg-primary/5 outline-dashed outline-2 -outline-offset-2 outline-primary/60",
                      )}
                      onDragOver={(event) => {
                        if (!event.dataTransfer.types.includes(SERVICE_DRAG_TYPE)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setUngroupedDragOver(true);
                      }}
                      onDragLeave={() => setUngroupedDragOver(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setUngroupedDragOver(false);
                        const serviceName = event.dataTransfer.getData(SERVICE_DRAG_TYPE);
                        if (serviceName) void removeFromGroups(serviceName);
                      }}
                    >
                      <div className="flex items-center justify-between gap-2 bg-muted/55 px-3 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
                        <span>{t("services.ungrouped")}</span>
                        <span className="text-muted-foreground/80">
                          {ungroupedServices.length}
                        </span>
                      </div>
                      <div className="divide-y divide-border">
                        {ungroupedServices.map((service) => (
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
                  ) : null}
                </div>
              ) : (
                <EmptyState label={t("services.empty")} />
              )}
            </CardContent>
          </Card>

        </div>

        <div className="min-h-0 min-w-0 overflow-auto">
          {selectedServiceDef ? (
            <div className="flex h-full min-h-0 flex-col">
              <AiContextTarget
                target={{
                  label: selectedServiceDef.name,
                  intents: selectedHealth?.agentContext ? [{
                    id: "debug-service",
                    label: t("services.debugWithAi"),
                    resolvePrompt: () =>
                      buildServiceDebugPrompt({
                        service: selectedServiceDef.name,
                        context: selectedHealth.agentContext ?? "",
                      }),
                    source: { type: "service-debug", label: selectedServiceDef.name },
                    agentLabel: `Debug \`${selectedServiceDef.name}\` with its current context.`,
                  }] : [],
                }}
              >
              <div className="shrink-0 space-y-2 border-b border-border bg-background/60 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="min-w-0 truncate text-base font-semibold">
                    {selectedServiceDef.name}
                  </h2>
                  <StateBadge state={selectedStatus?.state ?? "stopped"} />
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {(() => {
                      const openUrl =
                        selectedStatus?.url ??
                        (selectedServiceDef.port ? serviceUrl(selectedServiceDef.port) : undefined);
                      return openUrl ? (
                        <Tooltip label={t("services.openUrl", { url: openUrl })}>
                          <Button
                            aria-label={t("services.openInBrowser")}
                            className="size-7"
                            onClick={() => void openExternal(openUrl)}
                            size="icon"
                            type="button"
                            variant="outline"
                          >
                            <ExternalLink />
                          </Button>
                        </Tooltip>
                      ) : null;
                    })()}
                    <LifecycleActions
                      active={isServiceOn(selectedStatus?.state)}
                      baseUrl={`/api/services/${encodeURIComponent(selectedServiceDef.name)}`}
                      compact
                      resourceKind="service"
                      resourceName={selectedServiceDef.name}
                      targetLabel={selectedServiceDef.name}
                      onRefresh={onRefresh}
                    />
                    <OverflowMenu
                      className="size-7 border border-border bg-background opacity-100 hover:border-foreground/30"
                      items={[
                        {
                          icon: <Pencil className="size-3.5" />,
                          label: t("services.editService"),
                          onSelect: () => setEditOpen(true),
                        },
                        ...(isServiceOn(selectedStatus?.state)
                          ? []
                          : [
                              {
                                icon: <Trash2 className="size-3.5 text-destructive" />,
                                label: t("services.deleteService"),
                                onSelect: () => void deleteSelected(),
                              },
                            ]),
                      ]}
                      label={t("services.moreActions", { name: selectedServiceDef.name })}
                    />
                    <Tooltip
                      label={railCollapsed ? t("services.showRail") : t("services.hideRail")}
                      side="left"
                    >
                      <Button
                        aria-label={railCollapsed ? t("services.showRail") : t("services.hideRail")}
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
              </AiContextTarget>
              <div className="min-h-0 flex-1 overflow-auto">
                <ServiceDetailPanel
                  // Key by service so switching tears down the panel and
                  // reopens it on the default (Processes) tab — otherwise the
                  // previous service's tab/data (e.g. Env) sticks around.
                  key={selectedServiceDef.name}
                  serviceName={selectedServiceDef.name}
                  status={selectedStatus}
                  health={selectedHealth}
                  timeline={data.timeline ?? []}
                  onRefresh={onRefresh}
                />
              </div>
            </div>
          ) : (
            <EmptyState label={t("services.selectPrompt")} />
          )}
        </div>

        {!railCollapsed ? (
          <div className="min-h-0 overflow-auto border-l border-border">
            <PortsOverview ports={data.ports} />
            <DebugTimeline events={data.timeline ?? []} />
          </div>
        ) : null}
      </div>
      )}
      {editOpen && selectedServiceDef ? (
        <ComposerDialog
          icon={<Pencil />}
          onClose={() => setEditOpen(false)}
          size="lg"
          title={t("services.editServiceTitle", { name: selectedServiceDef.name })}
        >
          <ServiceForm
            cwd={data.cwd}
            initialService={selectedServiceDef}
            availableServices={serviceNames}
            onRefresh={onRefresh}
            repositories={data.config.gitRepositories}
            onSaved={() => setEditOpen(false)}
          />
        </ComposerDialog>
      ) : null}
      {serviceComposer ? (
        <ComposerDialog
          icon={serviceComposer === "service" ? <Plus /> : <Box />}
          onClose={() => setServiceComposer(null)}
          size={serviceComposer === "service" ? "lg" : "md"}
          title={serviceComposer === "service" ? t("services.addService") : t("services.createGroup")}
        >
          {serviceComposer === "service" ? (
            <ServiceForm
              cwd={data.cwd}
              availableServices={serviceNames}
              onRefresh={onRefresh}
              onSaved={() => setServiceComposer(null)}
              repositories={data.config.gitRepositories}
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
      {onboardOpen ? (
        <OnboardDialog onClose={() => setOnboardOpen(false)} onRefresh={onRefresh} />
      ) : null}
      {multiLogOpen ? (
        <MultiLogView
          initialService={selectedService || undefined}
          onClose={() => setMultiLogOpen(false)}
          services={data.config.services.map((service) => service.name)}
        />
      ) : null}
      {graphOpen ? (
        <ComposerDialog
          icon={<Workflow />}
          onClose={() => setGraphOpen(false)}
          size="lg"
          title={t("services.depGraphTitle")}
        >
          <DependencyGraph
            statuses={data.runtime.services}
            health={healthByService}
            hasDependencies={hasDependencies}
            onSelectService={(name) => {
              setSelectedService(name);
              setGraphOpen(false);
            }}
          />
        </ComposerDialog>
      ) : null}
    </>
  );
}

/** "+" button that opens a small menu to create a service or a group. */
function AddMenu({
  onCreateService,
  onCreateGroup,
  onCreateWithAi,
  onGroupWithAi,
  canGroupWithAi,
  onOnboardRepo,
  onOnboardWithAi,
}: {
  onCreateService: () => void;
  onCreateGroup: () => void;
  onCreateWithAi: () => void;
  onGroupWithAi: () => void;
  /** Only worth offering the AI grouping cut when 2+ services are ungrouped. */
  canGroupWithAi: boolean;
  onOnboardRepo: () => void;
  onOnboardWithAi: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="relative">
      <Tooltip label={t("services.add")} side="bottom">
        <Button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t("services.addServiceOrGroup")}
          className="size-7"
          onClick={() => setOpen((current) => !current)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Plus />
        </Button>
      </Tooltip>
      {open ? (
        <>
          <button
            aria-hidden
            className="fixed inset-0 z-[40] cursor-default"
            onClick={() => setOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <div
            className="absolute right-0 z-[50] mt-1 w-56 overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg"
            role="menu"
          >
            {/* Create Service: the plain form, plus an AI-setup section that
                emerges as a divided "cut" from the right when the row is hovered. */}
            <div className="group flex items-stretch">
              <button
                className="flex flex-1 items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-muted/60 [&_svg]:size-4"
                onClick={() => choose(onCreateService)}
                role="menuitem"
                type="button"
              >
                <Plus />
                {t("services.createService")}
              </button>
              <button
                className="flex max-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap border-l border-transparent px-0 text-[11px] font-medium text-muted-foreground opacity-0 transition-all duration-200 ease-out hover:bg-muted/60 hover:text-foreground group-hover:max-w-24 group-hover:border-border group-hover:px-3 group-hover:opacity-100"
                onClick={() => choose(onCreateWithAi)}
                role="menuitem"
                title={t("services.setupWithAiHint")}
                type="button"
              >
                <AgentMark className="size-3.5 shrink-0" />
                AI
              </button>
            </div>
            {/* Create Group: the plain form, plus an AI cut that asks the agent
                to propose groupings for the ungrouped services and group them
                on confirmation. The cut only appears when there's enough to group. */}
            <div className="group flex items-stretch">
              <button
                className="flex flex-1 items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-muted/60 [&_svg]:size-4"
                onClick={() => choose(onCreateGroup)}
                role="menuitem"
                type="button"
              >
                <Box />
                {t("services.createGroup")}
              </button>
              {canGroupWithAi ? (
                <button
                  className="flex max-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap border-l border-transparent px-0 text-[11px] font-medium text-muted-foreground opacity-0 transition-all duration-200 ease-out hover:bg-muted/60 hover:text-foreground group-hover:max-w-24 group-hover:border-border group-hover:px-3 group-hover:opacity-100"
                  onClick={() => choose(onGroupWithAi)}
                  role="menuitem"
                  title={t("services.groupWithAiHint")}
                  type="button"
                >
                  <AgentMark className="size-3.5 shrink-0" />
                  AI
                </button>
              ) : null}
            </div>
            {/* Add from GitHub: the structured wizard, plus an AI cut that hands
                the repo straight to the agent dock (the AI-native path). */}
            <div className="group flex items-stretch">
              <button
                className="flex flex-1 items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-muted/60 [&_svg]:size-4"
                onClick={() => choose(onOnboardRepo)}
                role="menuitem"
                type="button"
              >
                <GitBranch />
                {t("services.addFromGithub")}
              </button>
              <button
                className="flex max-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap border-l border-transparent px-0 text-[11px] font-medium text-muted-foreground opacity-0 transition-all duration-200 ease-out hover:bg-muted/60 hover:text-foreground group-hover:max-w-24 group-hover:border-border group-hover:px-3 group-hover:opacity-100"
                onClick={() => choose(onOnboardWithAi)}
                role="menuitem"
                title={t("services.onboardWithAiHint")}
                type="button"
              >
                <AgentMark className="size-3.5 shrink-0" />
                AI
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function showGroupTransitionToast({
  exitCodes,
  groupName,
  showErrorToast,
  showMessageToast,
  showSuccessToast,
  transitions,
  t,
}: {
  exitCodes: Array<number | null | undefined>;
  groupName: string;
  showErrorToast: (text: string) => void;
  showMessageToast: (message: { text: string }) => void;
  showSuccessToast: (text: string) => void;
  transitions: Map<ServiceStatus["state"], number>;
  t: Translate;
}) {
  if (transitions.size === 1) {
    const [state] = transitions.keys();
    if (state === "running") {
      showSuccessToast(t("services.toast.groupRunning", { name: groupName }));
    } else if (state === "stopped") {
      showMessageToast({ text: t("services.toast.groupStopped", { name: groupName }) });
    } else if (state === "starting") {
      showMessageToast({ text: t("services.toast.groupStarting", { name: groupName }) });
    } else if (state === "exited") {
      const knownCodes = exitCodes.filter((code) => code !== undefined && code !== null);
      showErrorToast(
        knownCodes.length
          ? t("services.toast.groupExitedWithCode", {
              name: groupName,
              code: knownCodes.join(", "),
            })
          : t("services.toast.groupExited", { name: groupName }),
      );
    }
    return;
  }

  const summary = [...transitions.entries()]
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
  const text = t("services.toast.groupUpdated", { name: groupName, summary });
  if (transitions.has("exited")) {
    showErrorToast(text);
  } else {
    showMessageToast({ text });
  }
}
