import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ScrollText,
  Square,
  Trash2,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useToasts } from "@/components/ui/toast";
import {
  deleteService,
  getServiceGraph,
  startService,
  stopService,
  type DashboardData,
  type ServiceStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { openExternal } from "@/lib/tauri";
import { useT } from "@/lib/i18n";
import { DebugTimeline } from "./debug-timeline";
import { DependencyGraph } from "./dependency-graph";
import { EmptyState } from "./empty-state";
import { FirstRunGuide } from "./first-run-guide";
import { HealthSummary } from "./health-summary";
import { PortsOverview } from "./ports-overview";
import { LifecycleActions } from "./service-actions";
import { MultiLogView } from "./multi-log-view";
import { ServiceDetailPanel } from "./service-detail-panel";
import { ComposerDialog, ServiceForm } from "./service-forms";
import { unassignedServices } from "./project-scope";
import { OnboardDialog } from "../onboard/onboard-dialog";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
import {
  buildServiceDebugPrompt,
  SETUP_SERVICE_PROMPT,
} from "../agent/prompts";
import {
  isServiceOn,
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
  const [serviceComposer, setServiceComposer] = useState<boolean | "service" | null>(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const { sendToAgent, startOnboard } = useAgentDock();
  const [multiLogOpen, setMultiLogOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const previousStatesRef = useRef<Record<string, ServiceStatus["state"]>>({});
  const {
    error: showErrorToast,
    message: showMessageToast,
    success: showSuccessToast,
  } = useToasts();
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
  const hasVisibleServices = data.config.services.length > 0;

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

  async function runBulkAction(action: "start" | "stop" | "restart") {
    if (bulkAction) return;
    if (
      (action === "stop" || action === "restart") &&
      !window.confirm(
        t(action === "stop" ? "services.confirmStopAll" : "services.confirmRestartAll"),
      )
    ) {
      return;
    }

    setBulkAction(action);
    try {
      const graph = await getServiceGraph();
      const knownNames = new Set(serviceNames);
      const graphOrder = graph.order.filter((name) => knownNames.has(name));
      const startOrder = graphOrder.length === serviceNames.length ? graphOrder : serviceNames;
      const stopOrder = [...startOrder].reverse();

      if (action === "stop" || action === "restart") {
        for (const name of stopOrder) {
          await stopService(name);
          await onRefresh();
        }
      }
      if (action === "start" || action === "restart") {
        for (const name of startOrder) {
          await startService(name);
          await onRefresh();
        }
      }
      showSuccessToast(t("services.toast.bulkRequested", { action: t(`common.${action}`) }));
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBulkAction(null);
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
      for (const service of data.config.services) {
        const nextState = nextStates[service.name];
        const previousState = previousStates[service.name];
        if (!previousState || previousState === nextState) continue;

        const status = data.runtime.services[service.name];
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

    }

    previousStatesRef.current = nextStates;
  }, [
    data.config.services,
    data.runtime.services,
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
        <div className="flex h-full items-center justify-center bg-background p-8 text-center">
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
          "grid h-full min-h-0 overflow-hidden bg-background",
          railCollapsed
            ? "lg:grid-cols-[320px_minmax(0,1fr)]"
            : "lg:grid-cols-[320px_minmax(0,1fr)_340px]",
        )}
      >
        <div className="min-h-0 min-w-0 overflow-auto border-r border-border">
          <section className="min-w-0">
            <header className="border-b border-border bg-card/75 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">{t("services.title")}</h2>
                  <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
                    {data.config.services.length}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    aria-haspopup="dialog"
                    aria-label={t("services.graph")}
                    className="size-7"
                    onClick={() => setGraphOpen(true)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Tooltip label={t("services.graph")} side="bottom">
                      <Workflow aria-hidden="true" className="size-3.5" />
                    </Tooltip>
                  </Button>
                  <Button
                    aria-haspopup="dialog"
                    aria-label={t("services.logs")}
                    className="size-7"
                    onClick={() => setMultiLogOpen(true)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Tooltip label={t("services.logs")} side="bottom">
                      <ScrollText aria-hidden="true" className="size-3.5" />
                    </Tooltip>
                  </Button>
                  <OverflowMenu
                    className="size-7 opacity-100"
                    items={[
                      {
                        icon: <Play className="size-3.5 text-emerald-600" />,
                        label: t("services.startAll"),
                        onSelect: () => void runBulkAction("start"),
                      },
                      {
                        icon: <RotateCcw className="size-3.5 text-amber-600" />,
                        label: t("services.restartAll"),
                        onSelect: () => void runBulkAction("restart"),
                      },
                      {
                        icon: <Square className="size-3.5 text-destructive" />,
                        label: t("services.stopAll"),
                        onSelect: () => void runBulkAction("stop"),
                      },
                    ]}
                    label={t("services.bulkActions")}
                  />
                  <AddMenu
                    onCreateService={() => setServiceComposer(true)}
                    onOnboardRepo={() => setOnboardOpen(true)}
                    onOnboardWithAi={startOnboard}
                    onCreateWithAi={() =>
                      sendToAgent({
                        prompt: SETUP_SERVICE_PROMPT,
                        source: { type: "service-setup", label: "Add a service" },
                        label: "Help me add a new service, one step at a time.",
                      })
                    }
                  />
                </div>
              </div>
            </header>
            <div>
              {/* Only in the all-projects view: a service belonging to no
                  project is invisible from every scoped view, so this is the
                  one place it can be found and assigned. */}
              {!scopeName && unassigned.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
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
                  <div className="divide-y divide-border">
                    {data.config.services.map((service) => (
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
              ) : (
                <EmptyState label={t("services.empty")} />
              )}
            </div>
          </section>

        </div>

        <div className="min-h-0 min-w-0 overflow-hidden">
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
              <div className="shrink-0 space-y-1.5 border-b border-border bg-card/75 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight">
                    {selectedServiceDef.name}
                  </h2>
                  <StateBadge state={selectedStatus?.state ?? "stopped"} />
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
                            variant="ghost"
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
                      className="size-7 opacity-100 hover:bg-muted"
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
              <div className="min-h-0 flex-1 overflow-hidden">
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
          icon={<Plus />}
          onClose={() => setServiceComposer(null)}
          size="lg"
          title={t("services.addService")}
        >
          <ServiceForm
            cwd={data.cwd}
            availableServices={serviceNames}
            onRefresh={onRefresh}
            onSaved={() => setServiceComposer(false)}
            repositories={data.config.gitRepositories}
          />
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

/** "+" button for service creation and repository onboarding. */
function AddMenu({
  onCreateService,
  onCreateWithAi,
  onOnboardRepo,
  onOnboardWithAi,
}: {
  onCreateService: () => void;
  onCreateWithAi: () => void;
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
          aria-label={t("services.addService")}
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
