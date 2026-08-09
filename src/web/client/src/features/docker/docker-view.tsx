import { useCallback, useMemo, useState } from "react";
import { Container, Layers3 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Loading } from "@/components/ui/loading";
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
  const [resourceRefreshVersion, setResourceRefreshVersion] = useState(0);

  const refreshAll = useCallback(async () => {
    setResourceRefreshVersion((current) => current + 1);
    await refresh();
  }, [refresh]);
  useRegisterRefresh(() => refresh({ silent: true }));

  const available = status?.available === true;
  const statsFor = useDockerStats(available && tab === "containers");
  const running = containers.filter(
    (container) => container.state === "running" || container.state === "restarting",
  ).length;
  const groups = useMemo(() => groupDockerContainers(containers), [containers]);
  const stacks = groups.filter((group) => group.project !== null).length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/75 px-3 py-2">
        <div
          aria-label={t("docker.resources")}
          className="flex max-w-full items-center gap-1 overflow-x-auto"
          role="tablist"
        >
          {TABS.map((entry) => (
            <button
              aria-controls={`docker-panel-${entry.id}`}
              aria-selected={tab === entry.id}
              className={cn(
                "shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === entry.id
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
              id={`docker-tab-${entry.id}`}
              key={entry.id}
              onClick={() => setTab(entry.id)}
              role="tab"
              type="button"
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
        <DockerInlineSummary
          containers={containers.length}
          loading={loading && status === null}
          running={running}
          stacks={stacks}
          version={status?.version}
        />
      </div>

      {error ? (
        <Alert aria-live="polite" className="m-4 shrink-0" variant="destructive">
          {error}
        </Alert>
      ) : null}

      {loading && status === null ? (
        <Loading className="flex-1" label={t("docker.loading")} />
      ) : status && !available ? (
        <DockerUnavailable error={status.error} />
      ) : tab === "containers" ? (
        <div
          aria-labelledby="docker-tab-containers"
          id="docker-panel-containers"
          className={cn(
            "relative grid min-h-0 flex-1 overflow-hidden transition-[grid-template-columns] duration-300 motion-reduce:transition-none",
            selected ? "lg:grid-cols-2" : "grid-cols-1",
          )}
          role="tabpanel"
        >
          <div className="min-h-0 overflow-auto p-4">
            <ContainerGroups
              groups={groups}
              onRefresh={refreshAll}
              onSelect={(container) => {
                const closing = selected?.id === container.id;
                setSelected(closing ? null : container);
              }}
              selectedId={selected?.id ?? null}
              statsFor={statsFor}
            />
          </div>
          {selected ? (
            <div className="absolute inset-0 z-20 min-h-0 animate-in bg-background fade-in-0 slide-in-from-right-3 duration-200 motion-reduce:animate-none lg:static lg:bg-transparent">
              <DockerDetailPanel
                container={selected}
                onClose={() => setSelected(null)}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div
          aria-labelledby={`docker-tab-${tab}`}
          className="min-h-0 flex-1 overflow-auto p-4"
          id={`docker-panel-${tab}`}
          role="tabpanel"
        >
          {tab === "images" ? (
            <DockerImagesTable active refreshVersion={resourceRefreshVersion} />
          ) : null}
          {tab === "volumes" ? (
            <DockerVolumesTable active refreshVersion={resourceRefreshVersion} />
          ) : null}
          {tab === "networks" ? (
            <DockerNetworksTable active refreshVersion={resourceRefreshVersion} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function DockerInlineSummary({
  containers,
  loading,
  running,
  stacks,
  version,
}: {
  containers: number;
  loading: boolean;
  running: number;
  stacks: number;
  version?: string;
}) {
  const t = useT();
  const stopped = Math.max(0, containers - running);

  return (
    <div
      aria-label={t("docker.hostSummary")}
      aria-live="polite"
      className="order-3 ml-auto flex w-full items-center justify-end gap-2 overflow-x-auto whitespace-nowrap font-mono text-[9px] tabular-nums text-muted-foreground sm:order-none sm:w-auto"
      role="status"
    >
      <InlineStat
        label={t("docker.summary.containers")}
        value={loading ? "—" : String(containers)}
      />
      <span aria-hidden="true" className="text-border">
        /
      </span>
      <InlineStat
        dot="bg-emerald-500"
        label={t("docker.summary.running")}
        value={loading ? "—" : String(running)}
      />
      <span aria-hidden="true" className="text-border">
        /
      </span>
      <InlineStat
        dot={stopped > 0 ? "bg-rose-500" : "bg-muted-foreground"}
        label={t("docker.summary.stopped")}
        value={loading ? "—" : String(stopped)}
      />
      <span aria-hidden="true" className="text-border">
        /
      </span>
      <InlineStat
        label={t("docker.summary.stacks")}
        value={loading ? "—" : String(stacks)}
      />
      {version ? (
        <>
          <span aria-hidden="true" className="text-border">
            /
          </span>
          <span translate="no">Docker v{version}</span>
        </>
      ) : null}
    </div>
  );
}

function InlineStat({
  dot,
  label,
  value,
}: {
  dot?: string;
  label: string;
  value: string;
}) {
  return (
    <span className="flex items-center gap-1">
      {dot ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot)} /> : null}
      <span className="font-semibold text-foreground">{value}</span>
      {label}
    </span>
  );
}

function DockerUnavailable({ error }: { error?: string }) {
  const t = useT();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Alert className="m-3" variant="muted">
        <Container aria-hidden="true" />
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
  groups,
  onRefresh,
  onSelect,
  selectedId,
  statsFor,
}: {
  groups: ReturnType<typeof groupDockerContainers>;
  onRefresh: () => Promise<void>;
  onSelect: (container: DockerContainerSummary) => void;
  selectedId: string | null;
  statsFor: ReturnType<typeof useDockerStats>;
}) {
  const t = useT();

  if (!groups.length) return <EmptyState label={t("docker.empty")} />;

  return (
    <div className="w-full divide-y divide-border/70 border-y border-border/70">
      {groups.map((group) => (
        <section className="py-1" key={group.project ?? "__ungrouped__"}>
          <div className="flex items-center gap-2 px-2 py-2.5">
            {group.project ? (
              <Layers3
                aria-hidden="true"
                className="size-3.5 text-sky-600 dark:text-sky-400"
              />
            ) : (
              <Container aria-hidden="true" className="size-3.5 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold">
                {group.project ?? t("docker.otherContainers")}
              </h3>
              <p className="text-[10px] text-muted-foreground">
                {group.project ? t("docker.composeStack") : t("docker.standaloneContainers")}
              </p>
            </div>
            <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-foreground">
              {t(
                group.containers.length === 1
                  ? "docker.containerCountOne"
                  : "docker.containerCount",
                { count: String(group.containers.length) },
              )}
            </span>
          </div>
          <div className="divide-y divide-border/60 border-t border-border/60">
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
