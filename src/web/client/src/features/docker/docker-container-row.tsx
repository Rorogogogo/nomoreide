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
  type DockerContainerSummary,
} from "@/lib/api";
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
}: {
  container: DockerContainerSummary;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const [logsOpen, setLogsOpen] = useState(false);
  const running = container.state === "running" || container.state === "restarting";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 hover:bg-muted/40">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={container.name}>
            {container.name}
          </span>
          <Badge size="small" variant={STATE_BADGE_VARIANT[container.state] ?? "outline"}>
            {container.state}
          </Badge>
        </div>
        <div className="truncate text-[11px] text-muted-foreground" title={container.image}>
          {container.image}
          {container.ports ? ` · ${container.ports}` : ""}
        </div>
      </div>
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
