import { FormEvent, useEffect, useState } from "react";
import { ChevronDown, ExternalLink, Pencil, Save } from "lucide-react";
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
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { HealthSummary } from "./health-summary";
import { ProcessBadge } from "./process-badge";
import { PortStateBadge } from "./ports-overview";
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
}: {
  allServices: DashboardData["config"]["services"];
  group: DashboardData["config"]["bundles"][number];
  onRefresh: () => Promise<void>;
  ports: PortOverview[];
  services: DashboardData["config"]["services"];
  health: DashboardData["health"];
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
                health={health[service.name]}
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

export function ServiceRow({
  service,
  status,
  health,
  ports,
  onRefresh,
}: {
  service: DashboardData["config"]["services"][number];
  status?: ServiceStatus;
  health?: ServiceHealth;
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
        <HealthSummary health={health} />
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
