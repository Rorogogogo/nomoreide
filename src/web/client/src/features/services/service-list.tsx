import { FormEvent, useEffect, useState } from "react";
import { ChevronDown, Pencil, Play, Save, Square } from "lucide-react";
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
  type ServiceStatus,
  type TimelineEvent,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
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
}) {
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const active = services.some((service) => isServiceOn(statuses[service.name]?.state));

  return (
    <section>
      <div className="flex items-center gap-1.5 bg-muted/35 px-3 py-1.5">
        <button
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
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
          targetLabel={`group ${group.name}`}
          onRefresh={onRefresh}
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
  const [busy, setBusy] = useState(false);
  const { error: showErrorToast } = useToasts();

  async function toggle(event: React.MouseEvent) {
    event.stopPropagation();
    setBusy(true);
    try {
      const action = active ? "stop" : "start";
      await postForm(`/api/services/${encodeURIComponent(service.name)}/${action}`, {});
      await onRefresh();
    } catch (caught) {
      showErrorToast(actionErrorMessage(active ? "Stop" : "Start", service.name, caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      aria-selected={selected}
      className={cn(
        "flex cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors",
        selected ? "border-l-2 border-primary bg-muted/70" : "border-l-2 border-transparent hover:bg-muted/30",
      )}
      onClick={onSelect}
      role="option"
    >
      <ProcessBadge command={service.command ?? ""} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{service.name}</div>
        {service.port ? (
          <div className="text-[11px] text-muted-foreground">:{service.port}</div>
        ) : null}
      </div>
      <StateBadge state={state} />
      <Tooltip label={active ? "Stop" : "Start"} side="left">
        <Button
          aria-label={active ? `Stop ${service.name}` : `Start ${service.name}`}
          className="size-7"
          disabled={busy}
          onClick={toggle}
          size="icon"
          type="button"
          variant="outline"
        >
          {active ? <Square /> : <Play />}
        </Button>
      </Tooltip>
    </div>
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

function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : undefined;
  } catch {
    return undefined;
  }
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
