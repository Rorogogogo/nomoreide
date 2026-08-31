import { HardDrive, Layers3, Network, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Loading } from "@/components/ui/loading";
import {
  getDockerImages,
  getDockerNetworks,
  getDockerVolumes,
  type DockerImageSummary,
  type DockerNetworkSummary,
  type DockerVolumeSummary,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { EmptyState } from "../services/empty-state";
import { useDockerResource } from "./use-docker";

/**
 * Images / Volumes / Networks. All three are read-only lists — pruning and
 * removal are destructive and stay out of this surface deliberately, the same
 * way GitManager stays read-safe.
 */
export function DockerImagesTable({
  active,
  refreshVersion = 0,
}: {
  active: boolean;
  refreshVersion?: number;
}) {
  const t = useT();
  const { rows, loading, error } = useDockerResource(
    getDockerImages,
    active,
    refreshVersion,
  );

  return (
    <ResourceShell
      columns={[
        t("docker.images.repository"),
        t("docker.images.tag"),
        t("docker.images.size"),
        t("docker.images.created"),
      ]}
      empty={t("docker.images.empty")}
      error={error}
      icon={Layers3}
      loading={loading}
      rowCount={rows.length}
      subtitle={t("docker.images.desc")}
      title={t("docker.tabImages")}
    >
      {rows.map((image: DockerImageSummary) => (
        <tr className="transition-colors hover:bg-muted/20" key={image.id + image.tag}>
          <Cell>
            <span className="flex items-center gap-1.5">
              <span className="truncate">{image.repository}</span>
              {image.dangling ? (
                <Badge size="small" variant="outline">
                  {t("docker.images.dangling")}
                </Badge>
              ) : null}
            </span>
          </Cell>
          <Cell mono>{image.tag}</Cell>
          <Cell>{image.size}</Cell>
          <Cell muted>{image.createdSince}</Cell>
        </tr>
      ))}
    </ResourceShell>
  );
}

export function DockerVolumesTable({
  active,
  refreshVersion = 0,
}: {
  active: boolean;
  refreshVersion?: number;
}) {
  const t = useT();
  const { rows, loading, error } = useDockerResource(
    getDockerVolumes,
    active,
    refreshVersion,
  );

  return (
    <ResourceShell
      columns={[
        t("docker.volumes.name"),
        t("docker.volumes.driver"),
        t("docker.volumes.mountpoint"),
      ]}
      empty={t("docker.volumes.empty")}
      error={error}
      icon={HardDrive}
      loading={loading}
      rowCount={rows.length}
      subtitle={t("docker.volumes.desc")}
      title={t("docker.tabVolumes")}
    >
      {rows.map((volume: DockerVolumeSummary) => (
        <tr className="transition-colors hover:bg-muted/20" key={volume.name}>
          <Cell mono>{volume.name}</Cell>
          <Cell>{volume.driver}</Cell>
          <Cell mono muted>
            {volume.mountpoint}
          </Cell>
        </tr>
      ))}
    </ResourceShell>
  );
}

export function DockerNetworksTable({
  active,
  refreshVersion = 0,
}: {
  active: boolean;
  refreshVersion?: number;
}) {
  const t = useT();
  const { rows, loading, error } = useDockerResource(
    getDockerNetworks,
    active,
    refreshVersion,
  );

  return (
    <ResourceShell
      columns={[
        t("docker.networks.name"),
        t("docker.networks.driver"),
        t("docker.networks.scope"),
      ]}
      empty={t("docker.networks.empty")}
      error={error}
      icon={Network}
      loading={loading}
      rowCount={rows.length}
      subtitle={t("docker.networks.desc")}
      title={t("docker.tabNetworks")}
    >
      {rows.map((network: DockerNetworkSummary) => (
        <tr className="transition-colors hover:bg-muted/20" key={network.id}>
          <Cell>{network.name}</Cell>
          <Cell>{network.driver}</Cell>
          <Cell muted>{network.scope}</Cell>
        </tr>
      ))}
    </ResourceShell>
  );
}

function ResourceShell({
  children,
  columns,
  empty,
  error,
  icon: Icon,
  loading,
  rowCount,
  subtitle,
  title,
}: {
  children: React.ReactNode;
  columns: string[];
  empty: string;
  error: string | null;
  icon: LucideIcon;
  loading: boolean;
  rowCount: number;
  subtitle: string;
  title: string;
}) {
  const t = useT();

  if (error) {
    return (
      <div aria-live="polite" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
        <p className="text-xs text-destructive">{error}</p>
      </div>
    );
  }
  if (loading && rowCount === 0) {
    return <Loading className="py-16" label={t("docker.loading")} />;
  }
  if (rowCount === 0) return <EmptyState label={empty} />;

  return (
    <section className="w-full overflow-hidden border-y border-border/70">
      <header className="flex items-center gap-2 px-2 py-2.5">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 className="text-xs font-semibold">{title}</h3>
          <p className="truncate text-[10px] text-muted-foreground">{subtitle}</p>
        </div>
        <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-foreground">
          {t(rowCount === 1 ? "docker.resourceCountOne" : "docker.resourceCount", {
            count: String(rowCount),
          })}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="border-t border-border/60 text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th
                  className="px-2 py-2 font-medium tracking-wide"
                  key={column}
                  scope="col"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">{children}</tbody>
        </table>
      </div>
    </section>
  );
}

function Cell({
  children,
  mono = false,
  muted = false,
}: {
  children: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={`max-w-0 truncate px-2 py-2.5 ${mono ? "font-mono" : ""} ${
        muted ? "text-muted-foreground" : ""
      }`}
    >
      {children}
    </td>
  );
}
