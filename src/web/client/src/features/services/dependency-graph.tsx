import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Loading } from "@/components/ui/loading";
import {
  getServiceGraph,
  type ServiceGraph,
  type ServiceGraphNode,
  type ServiceHealth,
  type ServiceStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const NODE_W = 150;
const NODE_H = 40;
const COL_W = 200;
const ROW_H = 64;
const PAD = 20;

/**
 * Read-only dependency/health graph for the Services view (IDEAS #9). Fetches
 * the structural graph (`dependsOn` edges, topological order, cycles) from the
 * server and overlays live state/health from the dashboard data the parent
 * already holds. Nodes are laid out in dependency layers (deps on the left).
 */
export function DependencyGraph({
  statuses,
  health,
  hasDependencies,
  onSelectService,
}: {
  statuses: Record<string, ServiceStatus>;
  health: Record<string, ServiceHealth>;
  hasDependencies: boolean;
  onSelectService: (name: string) => void;
}) {
  const t = useT();
  const [graph, setGraph] = useState<ServiceGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getServiceGraph()
      .then((result) => {
        if (active) setGraph(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, []);

  const layout = useMemo(() => (graph ? layoutGraph(graph.nodes) : null), [graph]);

  if (error) {
    return <Alert variant="destructive">{t("services.graph.loadError", { error })}</Alert>;
  }
  if (!graph || !layout) {
    return <Loading className="py-10" label={t("services.graph.loading")} />;
  }

  if (!hasDependencies) {
    return (
      <div className="grid gap-3">
        <Alert variant="muted">
          <div className="font-medium">{t("services.graph.noDeps")}</div>
          <div className="mt-1 text-xs">
            {t("services.graph.noDepsHint1")}{" "}
            <span className="font-medium">{t("services.graph.dependencies")}</span>
            {t("services.graph.noDepsHint2")}
          </div>
        </Alert>
      </div>
    );
  }

  const missing = graph.nodes.filter((node) => node.missing.length > 0);

  return (
    <div className="grid gap-3">
      {graph.cycles.length > 0 ? (
        <Alert variant="destructive">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-4" />
            {t("services.graph.cycleDetected")}
          </div>
          <div className="mt-1 text-xs">
            {graph.cycles.map((cycle) => cycle.join(" → ")).join("; ")}. {t("services.graph.cycleHint")}
          </div>
        </Alert>
      ) : null}
      {missing.length > 0 ? (
        <Alert variant="muted">
          <div className="text-xs">
            {missing.map((node) => (
              <div key={node.name}>
                <span className="font-medium">{node.name}</span>{" "}
                {t(
                  node.missing.length > 1
                    ? "services.graph.dependsUnknownMany"
                    : "services.graph.dependsUnknownOne",
                  { list: node.missing.join(", ") },
                )}
              </div>
            ))}
          </div>
        </Alert>
      ) : null}

      <div className="overflow-auto rounded-md border border-border bg-muted/20 p-2">
        <svg
          aria-label={t("services.graph.aria")}
          height={layout.height}
          role="img"
          width={layout.width}
        >
          {layout.edges.map((edge) => (
            <path
              className="fill-none stroke-border"
              d={edge.path}
              key={`${edge.from}->${edge.to}`}
              strokeWidth={1.5}
            />
          ))}
          {layout.nodes.map((node) => {
            const status = statuses[node.name];
            const color = nodeColor(status?.state, health[node.name]?.status);
            return (
              <g
                aria-label={t("services.graph.selectAria", { name: node.name })}
                className="cursor-pointer"
                key={node.name}
                onClick={() => onSelectService(node.name)}
                transform={`translate(${node.x}, ${node.y})`}
              >
                <rect
                  className={cn("stroke-2", color.fill, color.stroke)}
                  height={NODE_H}
                  rx={6}
                  width={NODE_W}
                />
                <circle className={color.dot} cx={14} cy={NODE_H / 2} r={4} />
                <text
                  className="fill-foreground text-[11px] font-medium"
                  dominantBaseline="middle"
                  x={26}
                  y={NODE_H / 2}
                >
                  {truncate(node.name)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {graph.order.length > 0 ? (
        <div className="text-[11px] text-muted-foreground">
          <span className="font-medium uppercase tracking-wide">{t("services.graph.startOrder")}</span>{" "}
          {graph.order.join(" → ")}
        </div>
      ) : null}
    </div>
  );
}

interface PositionedNode extends ServiceGraphNode {
  x: number;
  y: number;
}

interface GraphLayout {
  nodes: PositionedNode[];
  edges: Array<{ from: string; to: string; path: string }>;
  width: number;
  height: number;
}

/** Assign each node to a dependency layer (longest path from a root). */
function layoutGraph(nodes: ServiceGraphNode[]): GraphLayout {
  const depMap = new Map(nodes.map((node) => [node.name, node.dependsOn]));
  const layerOf = new Map<string, number>();
  const inProgress = new Set<string>();

  const resolveLayer = (name: string): number => {
    const cached = layerOf.get(name);
    if (cached !== undefined) return cached;
    if (inProgress.has(name)) return 0; // cycle guard — keep layout finite
    inProgress.add(name);
    const deps = depMap.get(name) ?? [];
    const layer = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => resolveLayer(dep) + 1));
    inProgress.delete(name);
    layerOf.set(name, layer);
    return layer;
  };
  for (const node of nodes) resolveLayer(node.name);

  const rowByLayer = new Map<number, number>();
  const positioned: PositionedNode[] = nodes.map((node) => {
    const layer = layerOf.get(node.name) ?? 0;
    const row = rowByLayer.get(layer) ?? 0;
    rowByLayer.set(layer, row + 1);
    return { ...node, x: PAD + layer * COL_W, y: PAD + row * ROW_H };
  });

  const byName = new Map(positioned.map((node) => [node.name, node]));
  const edges = positioned.flatMap((node) =>
    node.dependsOn.flatMap((dep) => {
      const from = byName.get(dep);
      if (!from) return [];
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = node.x;
      const y2 = node.y + NODE_H / 2;
      const midX = (x1 + x2) / 2;
      return [
        {
          from: dep,
          to: node.name,
          path: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
        },
      ];
    }),
  );

  const maxLayer = Math.max(0, ...positioned.map((node) => layerOf.get(node.name) ?? 0));
  const maxRows = Math.max(1, ...[...rowByLayer.values()]);
  return {
    nodes: positioned,
    edges,
    width: PAD * 2 + maxLayer * COL_W + NODE_W,
    height: PAD * 2 + (maxRows - 1) * ROW_H + NODE_H,
  };
}

function nodeColor(
  state: ServiceStatus["state"] | undefined,
  healthStatus: ServiceHealth["status"] | undefined,
) {
  if (state === "running") {
    if (healthStatus === "warning") {
      return { fill: "fill-amber-500/10", stroke: "stroke-amber-500/60", dot: "fill-amber-500" };
    }
    if (healthStatus === "unhealthy") {
      return { fill: "fill-red-500/10", stroke: "stroke-red-500/60", dot: "fill-red-500" };
    }
    return { fill: "fill-emerald-500/10", stroke: "stroke-emerald-500/60", dot: "fill-emerald-500" };
  }
  if (state === "starting") {
    return { fill: "fill-amber-500/10", stroke: "stroke-amber-500/60", dot: "fill-amber-500" };
  }
  if (state === "exited") {
    return { fill: "fill-red-500/10", stroke: "stroke-red-500/60", dot: "fill-red-500" };
  }
  return { fill: "fill-card", stroke: "stroke-border", dot: "fill-muted-foreground" };
}

function truncate(value: string, max = 18): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
