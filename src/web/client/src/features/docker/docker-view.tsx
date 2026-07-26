import { useState } from "react";
import { Container, Loader2, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { useT, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { DockerContainerSummary } from "@/lib/api";
import { EmptyState } from "../services/empty-state";
import { DockerContainerRow } from "./docker-container-row";
import { DockerDetailPanel } from "./docker-detail-panel";
import {
  DockerImagesTable,
  DockerNetworksTable,
  DockerVolumesTable,
} from "./docker-resource-tables";
import { groupDockerContainers, useDocker, useDockerStats } from "./use-docker";

const TABS = [
  { id: "containers", labelKey: "docker.tabContainers" },
  { id: "images", labelKey: "docker.tabImages" },
  { id: "volumes", labelKey: "docker.tabVolumes" },
  { id: "networks", labelKey: "docker.tabNetworks" },
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

type DockerTab = (typeof TABS)[number]["id"];

export function DockerView() {
  const t = useT();
  const { status, containers, loading, error, refresh } = useDocker();
  const [tab, setTab] = useState<DockerTab>("containers");
  const [selected, setSelected] = useState<DockerContainerSummary | null>(null);
  useRegisterRefresh(refresh);

  const available = status?.available === true;
  const statsFor = useDockerStats(available && tab === "containers");
  const running = containers.filter(
    (container) => container.state === "running" || container.state === "restarting",
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Container className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("nav.docker")}</span>
        <div className="ml-2 flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
          {TABS.map((entry) => (
            <button
              className={cn(
                "flex h-6 items-center rounded px-2.5 text-xs font-medium transition-colors",
                tab === entry.id
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              key={entry.id}
              onClick={() => setTab(entry.id)}
              type="button"
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
        {tab === "containers" && containers.length ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("docker.runningCount", {
              running: String(running),
              total: String(containers.length),
            })}
          </span>
        ) : null}
        {status?.version ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            v{status.version}
          </span>
        ) : null}
        <Button
          className="ml-auto h-7 gap-1.5 px-2 text-xs"
          onClick={() => void refresh()}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw className="size-3.5" />
          {t("common.refresh")}
        </Button>
      </header>

      {error ? (
        <Alert className="m-3 shrink-0" variant="destructive">
          {error}
        </Alert>
      ) : null}

      {loading && status === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("docker.loading")}
        </div>
      ) : status && !available ? (
        <DockerUnavailable error={status.error} />
      ) : tab === "containers" ? (
        <div
          className={cn(
            "grid min-h-0 flex-1 overflow-hidden",
            selected ? "lg:grid-cols-[minmax(0,1fr)_340px]" : "grid-cols-1",
          )}
        >
          <div className="min-h-0 overflow-auto">
            <ContainerGroups
              containers={containers}
              onRefresh={refresh}
              onSelect={(container) =>
                setSelected((current) => (current?.id === container.id ? null : container))
              }
              selectedId={selected?.id ?? null}
              statsFor={statsFor}
            />
          </div>
          {selected ? (
            <div className="hidden min-h-0 lg:block">
              <DockerDetailPanel container={selected} onClose={() => setSelected(null)} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === "images" ? <DockerImagesTable active /> : null}
          {tab === "volumes" ? <DockerVolumesTable active /> : null}
          {tab === "networks" ? <DockerNetworksTable active /> : null}
        </div>
      )}
    </div>
  );
}

function DockerUnavailable({ error }: { error?: string }) {
  const t = useT();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Alert className="m-3" variant="muted">
        <Container />
        <div>
          <p className="font-medium text-foreground">{t("docker.unavailable.title")}</p>
          <p className="mt-1 text-muted-foreground">{t("docker.unavailable.body")}</p>
          {error ? (
            <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 font-mono text-[11px] text-muted-foreground">
              {error}
            </pre>
          ) : null}
        </div>
      </Alert>
    </div>
  );
}

function ContainerGroups({
  containers,
  onRefresh,
  onSelect,
  selectedId,
  statsFor,
}: {
  containers: DockerContainerSummary[];
  onRefresh: () => Promise<void>;
  onSelect: (container: DockerContainerSummary) => void;
  selectedId: string | null;
  statsFor: ReturnType<typeof useDockerStats>;
}) {
  const t = useT();
  const groups = groupDockerContainers(containers);

  if (!groups.length) return <EmptyState label={t("docker.empty")} />;

  return (
    <div className="divide-y divide-border">
      {groups.map((group) => (
        <section key={group.project ?? "__ungrouped__"}>
          {/* Sticky stack label so the compose project stays identifiable while
              scrolling a long container list — same idiom as the table views. */}
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-1.5 text-xs font-medium backdrop-blur">
            {group.project ?? t("docker.otherContainers")}
            <span className="tabular-nums text-muted-foreground">
              {group.containers.length}
            </span>
          </div>
          <div className="divide-y divide-border">
            {group.containers.map((container) => (
              <DockerContainerRow
                key={container.id}
                container={container}
                onRefresh={onRefresh}
                onSelect={onSelect}
                selected={selectedId === container.id}
                stats={statsFor(container.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
