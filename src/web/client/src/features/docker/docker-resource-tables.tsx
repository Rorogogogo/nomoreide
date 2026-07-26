import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
export function DockerImagesTable({ active }: { active: boolean }) {
  const t = useT();
  const { rows, loading, error } = useDockerResource(getDockerImages, active);

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
      loading={loading}
      rowCount={rows.length}
    >
      {rows.map((image: DockerImageSummary) => (
        <tr className="hover:bg-muted/40" key={image.id + image.tag}>
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

export function DockerVolumesTable({ active }: { active: boolean }) {
  const t = useT();
  const { rows, loading, error } = useDockerResource(getDockerVolumes, active);

  return (
    <ResourceShell
      columns={[
        t("docker.volumes.name"),
        t("docker.volumes.driver"),
        t("docker.volumes.mountpoint"),
      ]}
      empty={t("docker.volumes.empty")}
      error={error}
      loading={loading}
      rowCount={rows.length}
    >
      {rows.map((volume: DockerVolumeSummary) => (
        <tr className="hover:bg-muted/40" key={volume.name}>
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

export function DockerNetworksTable({ active }: { active: boolean }) {
  const t = useT();
  const { rows, loading, error } = useDockerResource(getDockerNetworks, active);

  return (
    <ResourceShell
      columns={[
        t("docker.networks.name"),
        t("docker.networks.driver"),
        t("docker.networks.scope"),
      ]}
      empty={t("docker.networks.empty")}
      error={error}
      loading={loading}
      rowCount={rows.length}
    >
      {rows.map((network: DockerNetworkSummary) => (
        <tr className="hover:bg-muted/40" key={network.id}>
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
  loading,
  rowCount,
}: {
  children: React.ReactNode;
  columns: string[];
  empty: string;
  error: string | null;
  loading: boolean;
  rowCount: number;
}) {
  const t = useT();

  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>;
  if (loading && rowCount === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("docker.loading")}
      </div>
    );
  }
  if (rowCount === 0) return <EmptyState label={empty} />;

  return (
    <table className="w-full text-left text-xs">
      <thead className="sticky top-0 z-10 bg-muted/60 text-muted-foreground backdrop-blur">
        <tr>
          {columns.map((column) => (
            <th className="px-3 py-2 font-medium" key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">{children}</tbody>
    </table>
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
      className={`max-w-0 truncate px-3 py-1.5 ${mono ? "font-mono" : ""} ${
        muted ? "text-muted-foreground" : ""
      }`}
    >
      {children}
    </td>
  );
}
