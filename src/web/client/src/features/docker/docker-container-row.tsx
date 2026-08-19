import { useState, type ReactNode } from "react";
import { FolderOpen, Play, RotateCcw, ScrollText, Square } from "lucide-react";
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
  onBrowse,
  onRefresh,
  onSelect,
  selected,
  stats,
}: {
  container: DockerContainerSummary;
  onBrowse: (container: DockerContainerSummary) => void;
  onRefresh: () => Promise<void>;
  onSelect: (container: DockerContainerSummary) => void;
  selected: boolean;
  stats?: DockerContainerStats;
}) {
  const t = useT();
  const [logsOpen, setLogsOpen] = useState(false);
  const running = container.state === "running" || container.state === "restarting";
  const canBrowse = container.state === "running";

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 py-3 transition-colors",
        selected
          ? "bg-muted/45"
          : "hover:bg-muted/20",
      )}
    >
      {/* Only the info block opens the detail panel. Scoping the handler here
          rather than to the whole row means the action buttons need no
          stopPropagation, and the target stays a real keyboard stop. */}
      {/* A real <button>, so it only holds phrasing content — hence spans with
          `block`/`flex` rather than divs. */}
      <button
        aria-pressed={selected}
        className="min-w-0 cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onSelect(container)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full ring-4",
              container.state === "restarting"
                ? "bg-amber-500 ring-amber-500/10"
                : running
                  ? "bg-emerald-500 ring-emerald-500/10"
                  : "bg-rose-500 ring-rose-500/10",
            )}
          />
          <span className="truncate text-sm font-semibold tracking-tight" title={container.name}>
            {container.name}
          </span>
          <Badge
            size="small"
            variant={STATE_BADGE_VARIANT[container.state] ?? "outline"}
          >
            {container.state}
          </Badge>
        </span>
        <span className="mt-1 block truncate pl-4 text-[10px] text-muted-foreground">
          {container.status || t("docker.statusUnknown")}
          {container.service ? ` · ${container.service}` : ""}
          <span className="font-mono" translate="no">
            {" "}
            · {container.id.slice(0, 12)}
          </span>
        </span>
        <span className="mt-1 block truncate pl-4 font-mono text-[10px] text-muted-foreground">
          <span title={container.image} translate="no">
            {container.image}
          </span>
          {container.ports ? ` · ${container.ports}` : ""}
        </span>
        {stats && running ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-3 pl-4 font-mono text-[9px] tabular-nums text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400">
              CPU {formatPercent(stats.cpuPercent)}
            </span>
            <span className="text-sky-600 dark:text-sky-400">
              {t("docker.memoryShort")} {formatPercent(stats.memoryPercent)}
            </span>
            {stats.netIo ? <span>{t("docker.stats.net", { value: stats.netIo })}</span> : null}
          </span>
        ) : null}
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip
          label={t(canBrowse ? "docker.files.browse" : "docker.files.requiresRunning")}
        >
          <Button
            aria-label={t("docker.files.browse")}
            className="size-7"
            disabled={!canBrowse}
            onClick={() => onBrowse(container)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <FolderOpen aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip label={t("docker.actions.logs")}>
          <Button
            aria-label={t("docker.actions.logs")}
            className="size-7"
            onClick={() => setLogsOpen(true)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ScrollText aria-hidden="true" />
          </Button>
        </Tooltip>
        <ContainerActionButton
          action={running ? "restart" : "start"}
          container={container}
          icon={
            running ? <RotateCcw aria-hidden="true" /> : <Play aria-hidden="true" />
          }
          label={running ? t("common.restart") : t("common.start")}
          onRefresh={onRefresh}
        />
        {running ? (
          <ContainerActionButton
            action="stop"
            container={container}
            icon={<Square aria-hidden="true" />}
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
        className={cn(
          "size-7",
          action === "restart" &&
            "border-amber-600 bg-amber-600 text-white hover:bg-amber-700",
          action === "stop" && "border-red-600 bg-red-600 text-white hover:bg-red-700",
        )}
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
