import { useEffect, useId, useState } from "react";
import { ChevronDown, EyeOff, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  getDockerContainerDetail,
  type DockerContainerDetail,
  type DockerContainerSummary,
} from "@/lib/api";
import { useT, type Translate } from "@/lib/i18n";

/**
 * `docker inspect` for one container, rendered as the right-hand pane of the
 * Containers tab — the same detail-beside-list shape the Services view uses.
 */
export function DockerDetailPanel({
  container,
  onClose,
}: {
  container: DockerContainerSummary;
  onClose: () => void;
}) {
  const t = useT();
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    getDockerContainerDetail(container.id)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [container.id]);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          title={container.name}
        >
          {container.name}
        </span>
        <Tooltip label={t("common.close")}>
          <Button
            aria-label={t("common.close")}
            className="size-7"
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </Button>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-3 text-xs text-destructive">{error}</p>
        ) : !detail ? (
          <DetailSkeleton t={t} />
        ) : (
          <DetailBody detail={detail} t={t} />
        )}
      </div>
    </aside>
  );
}

function DetailBody({ detail, t }: { detail: DockerContainerDetail; t: Translate }) {
  return (
    <>
      <DetailSection title={t("docker.detail.overview")}>
        <FieldGrid
          rows={[
            [t("docker.detail.image"), detail.image],
            [t("docker.detail.command"), detail.command],
            [t("docker.detail.created"), formatTimestamp(detail.created)],
            [t("docker.detail.started"), formatTimestamp(detail.startedAt)],
            [t("docker.detail.restarts"), String(detail.restartCount)],
            [t("docker.detail.id"), detail.id.slice(0, 12)],
          ]}
        />
      </DetailSection>

      {detail.ports.length ? (
        <DetailSection title={t("docker.detail.ports")}>
          <FieldGrid
            rows={detail.ports.map((port) => [
              port.containerPort,
              port.hostPort || t("docker.detail.notPublished"),
            ])}
          />
        </DetailSection>
      ) : null}

      {detail.mounts.length ? (
        <DetailSection title={t("docker.detail.mounts")}>
          <ul className="space-y-1.5">
            {detail.mounts.map((mount) => (
              <li className="min-w-0" key={`${mount.source}:${mount.destination}`}>
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[11px]">{mount.destination}</span>
                  <Badge variant="outline">
                    {mount.readOnly ? "ro" : "rw"}
                  </Badge>
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {mount.type} · {mount.source}
                </div>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      {detail.networks.length ? (
        <DetailSection title={t("docker.detail.networks")}>
          <div className="flex flex-wrap gap-2">
            {detail.networks.map((network) => (
              <Badge key={network} variant="outline">
                {network}
              </Badge>
            ))}
          </div>
        </DetailSection>
      ) : null}

      {detail.env.length ? (
        <DetailSection title={t("docker.detail.env")}>
          <ul className="space-y-1">
            {detail.env.map((variable) => (
              <li className="min-w-0 font-mono text-[11px]" key={variable.key}>
                <span className="text-muted-foreground">{variable.key}=</span>
                <span className="break-all">{variable.value}</span>
                {variable.secret ? (
                  <Tooltip label={t("docker.detail.masked")}>
                    <EyeOff
                      aria-hidden="true"
                      className="ml-1 inline size-3 text-muted-foreground"
                    />
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      {Object.keys(detail.labels).length ? (
        <DetailSection title={t("docker.detail.labels")}>
          <FieldGrid rows={Object.entries(detail.labels)} mono />
        </DetailSection>
      ) : null}
    </>
  );
}

function DetailSkeleton({ t }: { t: Translate }) {
  return (
    <div
      aria-label={t("docker.detail.loading")}
      aria-live="polite"
      className="animate-pulse motion-reduce:animate-none"
      role="status"
    >
      <SkeletonSection rows={6} title={t("docker.detail.overview")} />
      <SkeletonSection rows={2} title={t("docker.detail.ports")} />
      <SkeletonSection rows={2} title={t("docker.detail.mounts")} />
    </div>
  );
}

const SKELETON_ROWS = [
  { id: "first", width: "82%" },
  { id: "second", width: "68%" },
  { id: "third", width: "54%" },
  { id: "fourth", width: "82%" },
  { id: "fifth", width: "68%" },
  { id: "sixth", width: "54%" },
] as const;

function SkeletonSection({ rows, title }: { rows: number; title: string }) {
  return (
    <section className="border-b border-border">
      <div className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="space-y-2 px-3 pb-2.5">
        {SKELETON_ROWS.slice(0, rows).map((row) => (
          <div
            className="grid grid-cols-[minmax(3.5rem,0.22fr)_minmax(0,1fr)] gap-3"
            key={row.id}
          >
            <span className="h-2 rounded-sm bg-muted" />
            <span className="h-2 rounded-sm bg-muted" style={{ width: row.width }} />
          </div>
        ))}
      </div>
    </section>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const contentId = useId();

  return (
    <section className="border-b border-border">
      <h3>
        <button
          aria-controls={contentId}
          aria-expanded={!collapsed}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setCollapsed((current) => !current)}
          type="button"
        >
          {title}
          <ChevronDown
            aria-hidden="true"
            className={`size-3.5 shrink-0 transition-transform ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
        </button>
      </h3>
      <div className="px-3 pb-2.5" hidden={collapsed} id={contentId}>
        {children}
      </div>
    </section>
  );
}

function FieldGrid({ rows, mono = false }: { rows: [string, string][]; mono?: boolean }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
      {rows.map(([label, value]) => (
        <div className="contents" key={label}>
          <dt className="truncate text-muted-foreground" title={label}>
            {label}
          </dt>
          <dd className={`min-w-0 break-all ${mono ? "font-mono" : ""}`}>{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Docker emits RFC3339 with nanoseconds; show the local minute, not the noise. */
function formatTimestamp(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // A never-started container reports the zero time.
  if (parsed.getUTCFullYear() <= 1) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}
