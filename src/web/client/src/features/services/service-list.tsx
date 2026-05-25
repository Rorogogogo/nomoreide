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
    <section
      className={cn(
        "transition-colors",
        dragOver && "bg-primary/5 outline-dashed outline-2 -outline-offset-2 outline-primary/60",
      )}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-1.5 bg-muted/35 px-3 py-1.5">
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
          <Badge size="small" variant="secondary">
            {group.services.length}
          </Badge>
        </button>
        <Tooltip label="Edit group">
          <Button
            aria-expanded={editing}
            aria-label={`Edit ${group.name}`}
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
          restartAction={async () => {
            await postForm(`/api/bundles/${encodeURIComponent(group.name)}/stop`, {});
            await postForm(`/api/bundles/${encodeURIComponent(group.name)}/start`, {});
          }}
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
    <div
      aria-selected={selected}
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
        "group flex cursor-pointer items-center gap-2 border-l-2 px-3 py-1.5 transition-colors",
        dragging && "opacity-50",
        selected
          ? "border-l-primary bg-primary/10"
          : "border-l-transparent hover:bg-muted",
      )}
      onClick={onSelect}
      role="option"
    >
      <ProcessBadge command={service.command ?? ""} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{service.name}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ServiceKindBadge kind={service.kind} />
          {service.port ? <span>:{service.port}</span> : null}
        </div>
      </div>
      <StateBadge state={state} />
      {/* Stop propagation so acting on a service doesn't also fight row selection. */}
      <span className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
        <LifecycleActions
          active={active}
          baseUrl={`/api/services/${encodeURIComponent(service.name)}`}
          compact
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
  local: { label: "local", className: "border-zinc-300 bg-zinc-100 text-zinc-600" },
  "docker-compose": { label: "docker", className: "border-sky-300 bg-sky-50 text-sky-700" },
  ssh: { label: "ssh", className: "border-violet-300 bg-violet-50 text-violet-700" },
};

export function ServiceKindBadge({ kind }: { kind?: ServiceKind }) {
  const meta = SERVICE_KIND_META[kind ?? "local"] ?? SERVICE_KIND_META.local;
  return (
    <span
      className={cn(
        "rounded border px-1 py-px text-[9px] font-semibold uppercase leading-none tracking-wide",
        meta.className,
      )}
    >
      {meta.label}
    </span>
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

export function serviceUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
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
      className={cn(state === "running" && "font-mono")}
    >
      {state}
    </Badge>
  );
}
