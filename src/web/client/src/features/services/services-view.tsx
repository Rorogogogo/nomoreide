import { FormEvent, useState } from "react";
import type { ReactNode } from "react";
import { Box, Play, Plus, RotateCcw, Square } from "lucide-react";
import { postForm, type DashboardData, type ServiceStatus } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function ServicesView({
  data,
  onRefresh,
}: {
  data: DashboardData;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="h-full overflow-auto pr-1">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid gap-5">
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle>Registered Services</CardTitle>
            <CardDescription>Start, stop, and inspect local project processes.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {data.config.services.length ? (
              <div className="divide-y divide-border">
                {data.config.services.map((service) => (
                  <ServiceRow
                    key={service.name}
                    service={service}
                    status={data.runtime.services[service.name]}
                    onRefresh={onRefresh}
                  />
                ))}
              </div>
            ) : (
              <EmptyState label="No services registered yet." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle>Bundles</CardTitle>
            <CardDescription>Grouped service commands for common work modes.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {data.config.bundles.length ? (
              <div className="divide-y divide-border">
                {data.config.bundles.map((bundle) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    key={bundle.name}
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{bundle.name}</div>
                      <div className="truncate text-sm text-muted-foreground">
                        {bundle.services.join(", ")}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <ActionButton
                        icon={<Play />}
                        label="Start"
                        url={`/api/bundles/${encodeURIComponent(bundle.name)}/start`}
                        onRefresh={onRefresh}
                      />
                      <ActionButton
                        icon={<Square />}
                        label="Stop"
                        url={`/api/bundles/${encodeURIComponent(bundle.name)}/stop`}
                        onRefresh={onRefresh}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState label="No bundles registered yet." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle>Recent Logs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <pre className="max-h-[360px] overflow-auto p-4 text-xs leading-6 text-muted-foreground">
              {data.logs.length
                ? data.logs
                    .map((entry) => `${entry.timestamp} ${entry.stream.padEnd(6)} ${entry.text}`)
                    .join("\n")
                : "No logs captured for the first registered service."}
            </pre>
          </CardContent>
        </Card>
      </div>

      <div className="grid content-start gap-5">
        <ServiceForm onRefresh={onRefresh} cwd={data.cwd} />
        <BundleForm onRefresh={onRefresh} />
      </div>
    </div>
    </div>
  );
}

function ServiceRow({
  service,
  status,
  onRefresh,
}: {
  service: DashboardData["config"]["services"][number];
  status?: ServiceStatus;
  onRefresh: () => Promise<void>;
}) {
  const state = status?.state ?? "stopped";
  return (
    <div className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Box className="size-4 text-muted-foreground" />
          <span className="font-medium">{service.name}</span>
          <StateBadge state={state} />
          {service.port ? <Badge variant="outline">:{service.port}</Badge> : null}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {service.command}
        </div>
        <div className="truncate text-xs text-muted-foreground">{service.cwd}</div>
      </div>
      <div className="flex gap-2">
        <ActionButton
          icon={<Play />}
          label="Start"
          url={`/api/services/${encodeURIComponent(service.name)}/start`}
          onRefresh={onRefresh}
        />
        <ActionButton
          icon={<Square />}
          label="Stop"
          url={`/api/services/${encodeURIComponent(service.name)}/stop`}
          onRefresh={onRefresh}
        />
        <ActionButton
          icon={<RotateCcw />}
          label="Restart"
          url={`/api/services/${encodeURIComponent(service.name)}/restart`}
          onRefresh={onRefresh}
        />
      </div>
    </div>
  );
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

function ActionButton({
  icon,
  label,
  url,
  onRefresh,
}: {
  icon: ReactNode;
  label: string;
  url: string;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await postForm(url, {});
          await onRefresh();
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

function ServiceForm({ cwd, onRefresh }: { cwd: string; onRefresh: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await postForm("/api/services", {
      name: String(form.get("name") ?? ""),
      command: String(form.get("command") ?? ""),
      cwd: String(form.get("cwd") ?? ""),
      port: String(form.get("port") ?? ""),
      description: String(form.get("description") ?? ""),
    });
    event.currentTarget.reset();
    await onRefresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="size-4" />
          Add Service
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <Label>
            Name
            <Input name="name" placeholder="backend" required />
          </Label>
          <Label>
            Command
            <Input name="command" placeholder="npm run dev" required />
          </Label>
          <Label>
            Working Directory
            <Input name="cwd" defaultValue={cwd} required />
          </Label>
          <Label>
            Port
            <Input name="port" inputMode="numeric" placeholder="3001" />
          </Label>
          <Label>
            Description
            <Input name="description" placeholder="API server" />
          </Label>
          <Button type="submit">Add Service</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function BundleForm({ onRefresh }: { onRefresh: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await postForm("/api/bundles", {
      name: String(form.get("name") ?? ""),
      services: String(form.get("services") ?? ""),
    });
    event.currentTarget.reset();
    await onRefresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Bundle</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <Label>
            Name
            <Input name="name" placeholder="full-stack" required />
          </Label>
          <Label>
            Services
            <Input name="services" placeholder="db, backend, frontend" required />
          </Label>
          <Button type="submit">Add Bundle</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <Alert variant="muted" className="m-4 text-center">
      {label}
    </Alert>
  );
}
