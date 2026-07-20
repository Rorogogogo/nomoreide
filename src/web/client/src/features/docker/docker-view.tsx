import { Container, Loader2, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { useT } from "@/lib/i18n";
import { EmptyState } from "../services/empty-state";
import { DockerContainerRow } from "./docker-container-row";
import { groupDockerContainers, useDocker } from "./use-docker";

export function DockerView() {
  const t = useT();
  const { status, containers, loading, error, refresh } = useDocker();
  useRegisterRefresh(refresh);

  if (loading && status === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("docker.loading")}
      </div>
    );
  }

  if (error) {
    return <Alert className="m-4" variant="destructive">{error}</Alert>;
  }

  if (status && !status.available) {
    return (
      <div className="p-4">
        <Alert variant="muted">
          <Container />
          <div>
            <p className="font-medium text-foreground">{t("docker.unavailable.title")}</p>
            <p className="mt-1 text-muted-foreground">{t("docker.unavailable.body")}</p>
            {status.error ? (
              <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 font-mono text-[11px] text-muted-foreground">
                {status.error}
              </pre>
            ) : null}
            <Button className="mt-3" onClick={() => void refresh()} size="sm" variant="outline">
              <RefreshCw />
              {t("common.refresh")}
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  const groups = groupDockerContainers(containers);

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("docker.desc")}</p>
        <Button onClick={() => void refresh()} size="sm" variant="outline">
          <RefreshCw />
          {t("common.refresh")}
        </Button>
      </div>
      {groups.length ? (
        <div className="space-y-4">
          {groups.map((group) => (
            <section
              key={group.project ?? "__ungrouped__"}
              className="overflow-hidden rounded-lg border border-border"
            >
              <div className="border-b border-border bg-muted/35 px-3 py-1.5 text-xs font-medium">
                {group.project ?? t("docker.otherContainers")}
              </div>
              <div className="divide-y divide-border">
                {group.containers.map((container) => (
                  <DockerContainerRow
                    key={container.id}
                    container={container}
                    onRefresh={refresh}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <EmptyState label={t("docker.empty")} />
      )}
    </div>
  );
}
