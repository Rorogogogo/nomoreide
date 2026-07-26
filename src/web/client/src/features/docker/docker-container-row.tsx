import { useState, type ReactNode } from "react";
import { Play, RotateCcw, ScrollText, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useToasts } from "@/components/ui/toast";
import { useOperations } from "@/components/operations/operation-context";
import {
  runDockerContainerAction,
  type DockerContainerAction,
  type DockerContainerStats,
  type DockerContainerSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { DockerLogsDialog } from "./docker-logs-dialog";

const STATE_BADGE_VARIANT: Record<string, "success" | "danger" | "warning" | "outline"> = {
  running: "success",
  restarting: "warning",
  exited: "danger",
  dead: "danger",
  paused: "outline",
  created: "outline",
};

export function DockerContainerRow({
  container,
  onRefresh,
  onSelect,
  selected,
  stats,
}: {
  container: DockerContainerSummary;
  onRefresh: () => Promise<void>;
  onSelect: (container: DockerContainerSummary) => void;
  selected: boolean;
  stats?: DockerContainerStats;
}) {
  const t = useT();
  const [logsOpen, setLogsOpen] = useState(false);
  const running = container.state === "running" || container.state === "restarting";

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2",
        selected ? "bg-muted/70" : "hover:bg-muted/40",
      )}
    >
      {/* Only the info block opens the detail panel. Scoping the handler here
          rather than to the whole row means the action buttons need no
          stopPropagation, and the target stays a real keyboard stop. */}
      {/* A real <button>, so it only holds phrasing content — hence spans with
          `block`/`flex` rather than divs. */}
      <button
        aria-pressed={selected}
        className="min-w-0 cursor-pointer rounded-sm text-left"
        onClick={() => onSelect(container)}
        type="button"
      >
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={container.name}>
            {container.name}
          </span>
          <Badge size="small" variant={STATE_BADGE_VARIANT[container.state] ?? "outline"}>
            {container.state}
          </Badge>
          {/* `status` carries the uptime Docker already computed ("Up 2 hours"). */}
          {container.status ? (
            <span className="truncate text-[11px] font-normal text-muted-foreground">
              {container.status}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          <span title={container.image}>{container.image}</span>
          {container.service ? ` · ${container.service}` : ""}
          <span className="font-mono"> · {container.id.slice(0, 12)}</span>
        </span>
        {container.ports ? (
          <span
            className="block truncate font-mono text-[11px] text-muted-foreground"
            title={container.ports}
          >
            {container.ports}
          </span>
        ) : null}
        {stats && running ? (
          <span className="flex flex-wrap items-center gap-x-3 text-[11px] tabular-nums text-muted-foreground">
            <span>{t("docker.stats.cpu", { value: formatPercent(stats.cpuPercent) })}</span>
            <span>
              {t("docker.stats.mem", {
                usage: stats.memoryUsage || "—",
                percent: formatPercent(stats.memoryPercent),
              })}
            </span>
            {stats.netIo ? <span>{t("docker.stats.net", { value: stats.netIo })}</span> : null}
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip label={t("docker.actions.logs")}>
          <Button
            aria-label={t("docker.actions.logs")}
            className="size-7"
            onClick={() => setLogsOpen(true)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ScrollText />
          </Button>
        </Tooltip>
        <ContainerActionButton
          action={running ? "restart" : "start"}
          container={container}
          icon={running ? <RotateCcw /> : <Play />}
          label={running ? t("common.restart") : t("common.start")}
          onRefresh={onRefresh}
        />
        {running ? (
          <ContainerActionButton
            action="stop"
            container={container}
            icon={<Square />}
            label={t("common.stop")}
            onRefresh={onRefresh}
          />
        ) : null}
      </div>
      {logsOpen ? (
        <DockerLogsDialog container={container} onClose={() => setLogsOpen(false)} />
      ) : null}
    </div>
  );
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function ContainerActionButton({
  action,
  container,
  icon,
  label,
  onRefresh,
}: {
  action: DockerContainerAction;
  container: DockerContainerSummary;
  icon: ReactNode;
  label: string;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const { error: showError, success: showSuccess } = useToasts();
  const { isPending, runOperation } = useOperations();
  const operationKey = `docker:${container.id}:${action}`;
  const busy = isPending(operationKey);

  return (
    <Tooltip label={label}>
      <Button
        aria-label={label}
        className="size-7"
        loading={busy}
        loadingLabel={label}
        onClick={() =>
          void runOperation(
            { key: operationKey, label },
            async () => {
              try {
                await runDockerContainerAction(container.id, action);
                showSuccess(t("docker.actions.done", { label, name: container.name }));
                await onRefresh();
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : String(caught);
                showError(
                  t("docker.actions.failed", { label, name: container.name, message }),
                );
              }
            },
          )
        }
        size="icon"
        type="button"
        variant="outline"
      >
        {icon}
      </Button>
    </Tooltip>
  );
}
