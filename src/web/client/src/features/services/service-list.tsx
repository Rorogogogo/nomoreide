import { type DragEvent, type FormEvent, useEffect, useState } from "react";
import { ChevronDown, Pencil, Save } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import {
  postForm,
  type DashboardData,
  type PortOverview,
  type ServiceHealth,
  type ServiceKind,
  type ServiceStatus,
  type TimelineEvent,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Tooltip } from "@/components/ui/tooltip";
import { setAgentPathData } from "../agent/chat/drag-to-agent";
import { ProcessBadge } from "./process-badge";
import { GroupForm } from "./service-forms";
import { LifecycleActions, actionErrorMessage } from "./service-actions";

export function ServiceGroupSection({
  allServices,
  group,
  onRefresh,
  ports,
  services,
  health,
  statuses,
  timeline,
  selectedService,
  onSelectService,
  onDropService,
}: {
  allServices: DashboardData["config"]["services"];
  group: DashboardData["config"]["bundles"][number];
  onRefresh: () => Promise<void>;
  ports: PortOverview[];
  services: DashboardData["config"]["services"];
  health: DashboardData["health"];
  statuses: DashboardData["runtime"]["services"];
  timeline: TimelineEvent[];
  selectedService?: string;
  onSelectService: (name: string) => void;
  onDropService?: (serviceName: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const active = services.some((service) => isServiceOn(statuses[service.name]?.state));

  function handleDragOver(event: DragEvent) {
    if (!onDropService || !event.dataTransfer.types.includes(SERVICE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function handleDrop(event: DragEvent) {
    if (!onDropService) return;
    event.preventDefault();
    setDragOver(false);
    const serviceName = event.dataTransfer.getData(SERVICE_DRAG_TYPE);
    if (serviceName) onDropService(serviceName);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Native drag-and-drop target; its controls remain keyboard accessible.
    <section
      className={cn(
        "transition-colors",
        dragOver && "bg-primary/5 outline-dashed outline-2 -outline-offset-2 outline-primary/60",
      )}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <button
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
          onClick={() => setCollapsed((current) => !current)}
          type="button"
        >
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              collapsed && "-rotate-90",
            )}
          />
          <span className="truncate text-sm font-medium">{group.name}</span>
          {group.services.length ? (
            <Badge size="small" variant="secondary">
              {group.services.length}
            </Badge>
          ) : null}
        </button>
        <Tooltip label={t("services.list.editGroup")}>
          <Button
            aria-expanded={editing}
            aria-label={t("services.list.editName", { name: group.name })}
            className="size-7"
            onClick={() => setEditing((current) => !current)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Pencil />
          </Button>
        </Tooltip>
        <LifecycleActions
          active={active}
          baseUrl={`/api/bundles/${encodeURIComponent(group.name)}`}
          compact
          resourceKind="bundle"
          resourceName={group.name}
          solidStart
          targetLabel={`group ${group.name}`}
          onRefresh={onRefresh}
          onStarted={() => {
            const first = services[0];
            if (first) onSelectService(first.name);
          }}
        />
      </div>
      {editing ? (
        <div className="border-t border-border p-3">
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
        <div className="divide-y divide-border/70 border-t border-border/70">
          {services.length ? (
            services.map((service) => (
              <ServiceRow
                key={service.name}
                service={service}
                status={statuses[service.name]}
                health={health[service.name]}
                ports={ports}
                onRefresh={onRefresh}
                timeline={timeline}
                selected={selectedService === service.name}
                onSelect={() => onSelectService(service.name)}
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

export function ServiceRow({
  service,
  status,
  onRefresh,
  selected = false,
  onSelect,
}: {
  service: DashboardData["config"]["services"][number];
  status?: ServiceStatus;
  health?: ServiceHealth;
  ports?: PortOverview[];
  onRefresh: () => Promise<void>;
  timeline?: TimelineEvent[];
  selected?: boolean;
  onSelect?: () => void;
}) {
  const state = status?.state ?? "stopped";
  const active = isServiceOn(state);
  const [dragging, setDragging] = useState(false);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Native drag source; selection is handled by the nested button.
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(SERVICE_DRAG_TYPE, service.name);
        // Also carry the service's directory so it can be dropped into the
        // agent dock as an absolute path (group drop zones key off the type
        // above, so the two targets never collide).
        if (service.cwd) setAgentPathData(event.dataTransfer, service.cwd);
        event.dataTransfer.effectAllowed = "copyMove";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 transition-colors focus-within:bg-muted/30",
        dragging && "opacity-50",
        selected
          ? "border-l-2 border-primary bg-muted/45 pl-2.5"
          : "hover:bg-muted/20",
      )}
    >
      <button
        aria-pressed={selected}
        className="grid min-w-0 cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onSelect}
        type="button"
      >
        <ProcessBadge command={service.command ?? ""} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold tracking-tight">
            {service.name}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ServiceKindBadge kind={service.kind} />
            {service.port ? <span>:{service.port}</span> : null}
          </span>
        </span>
        <StateDot state={state} />
      </button>
      <span className="flex items-center gap-1">
        <LifecycleActions
          active={active}
          baseUrl={`/api/services/${encodeURIComponent(service.name)}`}
          compact
          resourceKind="service"
          resourceName={service.name}
          targetLabel={service.name}
          onRefresh={onRefresh}
          onStarted={onSelect}
        />
      </span>
    </div>
  );
}

export const SERVICE_DRAG_TYPE = "application/x-nomoreide-service";

const SERVICE_KIND_META: Record<ServiceKind, { label: string; className: string }> = {
  local: {
    label: "local",
    className: "border-border/70 bg-background text-muted-foreground",
  },
  "docker-compose": {
    label: "docker",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  ssh: {
    label: "ssh",
    className: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
};

export function ServiceKindBadge({ kind }: { kind?: ServiceKind }) {
  const meta = SERVICE_KIND_META[kind ?? "local"] ?? SERVICE_KIND_META.local;
  return (
    <Badge
      appearance="outline"
      className={cn(
        "text-[9px] font-semibold uppercase tracking-wide",
        meta.className,
      )}
      size="small"
      variant="secondary"
    >
      {meta.label}
    </Badge>
  );
}

export function isServiceOn(state: ServiceStatus["state"] | undefined): boolean {
  return state === "running" || state === "starting";
}

export function PortEditor({
  service,
  onRefresh,
}: {
  service: DashboardData["config"]["services"][number];
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
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
        command: service.command ?? "",
        cwd: service.cwd ?? "",
        port,
        description: service.description,
      });
      showSuccessToast(`Port saved for ${service.name}.`);
      await onRefresh();
    } catch (caught) {
      showErrorToast(actionErrorMessage(t, t("services.list.savePort"), service.name, caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex items-center gap-1.5" onSubmit={submit}>
      <Input
        aria-label={t("services.list.portFor", { name: service.name })}
        className="h-8 w-20 font-mono text-xs"
        inputMode="numeric"
        min={1}
        max={65535}
        onChange={(event) => setPort(event.target.value)}
        placeholder={t("services.list.portPlaceholder")}
        type="number"
        value={port}
      />
      <Button
        aria-label={t("services.list.savePortFor", { name: service.name })}
        disabled={busy || !dirty}
        className="size-8"
        size="icon"
        title={t("services.list.savePort")}
        type="submit"
        variant="outline"
      >
        <Save />
      </Button>
    </form>
  );
}

export function serviceUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

const STATE_DOT_META: Record<ServiceStatus["state"], { className: string; pulse?: boolean }> = {
  running: { className: "bg-emerald-500" },
  starting: { className: "bg-amber-500", pulse: true },
  exited: { className: "bg-red-500" },
  stopped: { className: "bg-muted-foreground/40" },
};

// Compact status indicator for dense list rows — the word version (StateBadge)
// repeats what the Start/Stop button already conveys and eats a whole column.
export function StateDot({ state }: { state: ServiceStatus["state"] }) {
  const meta = STATE_DOT_META[state] ?? STATE_DOT_META.stopped;
  return (
    <span className="relative flex size-2.5 items-center justify-center" title={state}>
      {meta.pulse && (
        <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", meta.className)} />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", meta.className)} />
    </span>
  );
}

export function StateBadge({ state }: { state: ServiceStatus["state"] }) {
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
      className={cn(
        "rounded-lg border-border/70 px-2 text-[11px] font-medium shadow-none",
        state === "running" && "font-mono",
      )}
    >
      {state}
    </Badge>
  );
}
