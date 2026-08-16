import { useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  useNodesState,
} from "@xyflow/react";
import { FileText, FolderGit2, Pin, Server, TerminalSquare, TriangleAlert } from "lucide-react";
import type { ContextGraph as ContextGraphData, ContextItem, ContextKind, ContextRef } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const NODE_W = 168;
const NODE_H = 48;
const PAD = 72;
const KIND_ORDER: ContextKind[] = ["project", "service", "file", "incident", "session", "note"];

interface ContextNodeData extends Record<string, unknown> {
  item: ContextItem;
  label: string;
}

type ContextFlowNode = Node<ContextNodeData, "context">;

function key(ref: ContextRef) {
  return `${ref.kind}:${ref.id}`;
}

export function ContextGraph({
  graph,
  items,
  onSelect,
  selected,
}: {
  graph: ContextGraphData;
  items: ContextItem[];
  onSelect: (item: ContextItem) => void;
  selected?: ContextRef;
}) {
  const t = useT();
  const initialNodes = useMemo(() => layoutContextNodes(graph, items), [graph, items]);
  const edges = useMemo(() => contextEdges(graph, selected), [graph, selected?.kind, selected?.id]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ContextFlowNode>(initialNodes);

  useEffect(() => setNodes(initialNodes), [initialNodes, setNodes]);
  useEffect(() => {
    const selectedKey = selected ? key(selected) : null;
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === selectedKey })));
  }, [selected, setNodes]);

  if (!graph.nodes.length) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">{t("context.noMatches")}</div>;
  }

  return (
    <div className="context-flow h-full min-h-[320px] overflow-hidden border-y border-border bg-background">
      <ReactFlow<ContextFlowNode, Edge>
        aria-label={t("context.graphAria")}
        defaultEdgeOptions={{ type: "straight" }}
        edges={edges}
        elevateEdgesOnSelect
        fitView
        fitViewOptions={{ padding: 0.24, maxZoom: 1.2 }}
        maxZoom={1.8}
        minZoom={0.22}
        nodeTypes={NODE_TYPES}
        nodes={nodes}
        nodesConnectable={false}
        nodesFocusable
        onNodeClick={(_, node) => onSelect(node.data.item)}
        onNodesChange={onNodesChange}
        onlyRenderVisibleElements
        panOnScroll
        proOptions={{ hideAttribution: true }}
        selectionOnDrag
        zoomOnDoubleClick={false}
      >
        <Background color="hsl(var(--border) / 0.55)" gap={28} size={1} variant={BackgroundVariant.Cross} />
        <Controls fitViewOptions={{ padding: 0.2 }} position="bottom-left" showInteractive={false} />
        {nodes.length > 10 ? (
          <MiniMap
            ariaLabel={t("context.graphMinimap")}
            maskColor="hsl(var(--background) / 0.72)"
            nodeColor={(node) => minimapColor((node.data as ContextNodeData).item.kind)}
            pannable
            position="bottom-right"
            zoomable
          />
        ) : null}
        <Panel className="context-flow-panel" position="top-left">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {KIND_ORDER.filter((kind) => nodes.some((node) => node.data.item.kind === kind)).map((kind) => (
              <span className="flex items-center gap-1.5 text-[9px] text-muted-foreground" key={kind}>
                <span className={cn("size-2 border border-muted-foreground/70", kindGeometry(kind))} />
                {kind}
              </span>
            ))}
          </div>
        </Panel>
        <Panel className="context-flow-panel" position="top-right">
          <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
            {t("context.graphSummary", { nodes: graph.nodes.length, edges: graph.edges.length })}
            {graph.truncated ? ` · ${t("context.graphTruncated")}` : ""}
          </span>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export function layoutContextNodes(graph: ContextGraphData, items: ContextItem[]): ContextFlowNode[] {
  const itemByKey = new Map(items.map((item) => [key(item.ref), item]));
  const visible = graph.nodes.flatMap((node) => {
    const item = itemByKey.get(key(node.ref));
    if (!item) return [];
    return [{ node, item }];
  });
  if (!visible.length) return [];

  const indexById = new Map(visible.map((entry, index) => [key(entry.node.ref), index]));
  const radius = Math.max(180, Math.sqrt(visible.length) * 92);
  const points = visible.map((entry, index) => {
    const angle = hashUnit(key(entry.node.ref)) * Math.PI * 2;
    const orbit = kindOrbit(entry.node.kind);
    const jitter = ((index * 0.61803398875) % 1) * 0.18;
    return {
      x: Math.cos(angle) * radius * (orbit + jitter),
      y: Math.sin(angle) * radius * (orbit + jitter),
      vx: 0,
      vy: 0,
    };
  });
  const links = graph.edges.flatMap((edge) => {
    const source = indexById.get(key(edge.from));
    const target = indexById.get(key(edge.to));
    return source === undefined || target === undefined ? [] : [{ source, target, type: edge.type }];
  });

  for (let iteration = 0; iteration < 180; iteration += 1) {
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        const a = points[left];
        const b = points[right];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        if (dx === 0 && dy === 0) {
          dx = hashUnit(`${left}:${right}`) - 0.5;
          dy = hashUnit(`${right}:${left}`) - 0.5;
        }
        const distanceSquared = Math.max(16, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        const collision = Math.max(0, 132 - distance) * 0.035;
        const force = Math.min(4.5, 12_000 / distanceSquared) + collision;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
    for (const link of links) {
      const source = points[link.source];
      const target = points[link.target];
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const pull = clamp((distance - relationLength(link.type)) * 0.018, -1.8, 2.8);
      const fx = (dx / distance) * pull;
      const fy = (dy / distance) * pull;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const centrePull = visible[index].node.kind === "project" ? 0.012 : 0.004;
      point.vx -= point.x * centrePull;
      point.vy -= point.y * centrePull;
      point.vx = clamp(point.vx * 0.76, -9, 9);
      point.vy = clamp(point.vy * 0.76, -9, 9);
      point.x += point.vx;
      point.y += point.vy;
    }
  }

  normalizeConstellation(points);

  const minX = Math.min(...points.map((point) => point.x - NODE_W / 2));
  const minY = Math.min(...points.map((point) => point.y - NODE_H / 2));
  return visible.map((entry, index) => {
    const point = points[index];
    return {
      id: key(entry.node.ref),
      type: "context",
      position: {
        x: roundPosition(point.x - NODE_W / 2 - minX + PAD),
        y: roundPosition(point.y - NODE_H / 2 - minY + PAD),
      },
      data: { item: entry.item, label: entry.node.title },
      width: NODE_W,
      height: NODE_H,
    } satisfies ContextFlowNode;
  });
}

function contextEdges(graph: ContextGraphData, selected?: ContextRef): Edge[] {
  const selectedKey = selected ? key(selected) : null;
  return graph.edges.map((edge) => ({
    id: `${key(edge.from)}>${key(edge.to)}:${edge.type}`,
    source: key(edge.from),
    target: key(edge.to),
    type: "straight",
    ariaLabel: edge.type,
    markerEnd: { type: MarkerType.ArrowClosed, width: 9, height: 9 },
    style: {
      stroke: selectedKey && (key(edge.from) === selectedKey || key(edge.to) === selectedKey)
        ? "hsl(var(--foreground))"
        : "hsl(var(--border))",
      strokeDasharray: relationDash(edge.type),
      strokeWidth: selectedKey && (key(edge.from) === selectedKey || key(edge.to) === selectedKey) ? 1.5 : 1,
      opacity: selectedKey && key(edge.from) !== selectedKey && key(edge.to) !== selectedKey ? 0.35 : 0.9,
    },
  }));
}

const NODE_TYPES = { context: ContextNode };

function ContextNode({ data, selected }: NodeProps<ContextFlowNode>) {
  const { item, label } = data;
  const Icon = kindIcon(item.kind);
  return (
    <div
      className={cn(
        "group flex h-12 w-[168px] items-center gap-2 text-foreground",
        selected && "z-10",
      )}
      title={`${label} · ${item.kind}`}
    >
      <Handle className="!size-1 !border-0 !bg-transparent" position={Position.Left} type="target" />
      <span className={cn(
        "grid size-8 shrink-0 place-items-center border bg-background transition-colors",
        kindGeometry(item.kind),
        selected ? "border-foreground bg-foreground text-background" : kindSurface(item.kind),
      )}>
        <Icon aria-hidden="true" className={cn("size-3.5", kindIconTransform(item.kind))} />
      </span>
      <span className={cn("min-w-0 flex-1 border-l pl-2", selected ? "border-foreground" : "border-border")}>
        <span className="block truncate text-[11px] font-medium leading-tight">{label}</span>
        <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">{item.kind}</span>
      </span>
      {item.pinned ? <Pin aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" /> : null}
      <Handle className="!size-1 !border-0 !bg-transparent" position={Position.Right} type="source" />
    </div>
  );
}

function kindIcon(kind: ContextKind) {
  return {
    note: FileText,
    project: FolderGit2,
    service: Server,
    file: FileText,
    incident: TriangleAlert,
    session: TerminalSquare,
  }[kind];
}

function kindGeometry(kind: ContextKind): string {
  return {
    project: "rotate-45 rounded-[2px]",
    service: "rounded-full",
    file: "rounded-[2px]",
    incident: "rotate-45 rounded-full",
    session: "rounded-full border-dashed",
    note: "rotate-45 rounded-[2px] border-dashed",
  }[kind];
}

function kindSurface(kind: ContextKind): string {
  return {
    note: "border-muted-foreground/60 text-muted-foreground",
    project: "border-foreground text-foreground",
    service: "border-muted-foreground text-foreground",
    file: "border-border text-muted-foreground",
    incident: "border-red-500 text-red-600 dark:text-red-400",
    session: "border-muted-foreground/70 text-muted-foreground",
  }[kind];
}

function kindIconTransform(kind: ContextKind): string {
  return kind === "project" || kind === "note" || kind === "incident" ? "-rotate-45" : "";
}

function minimapColor(kind: ContextKind): string {
  return {
    note: "hsl(var(--muted-foreground))",
    project: "hsl(var(--foreground))",
    service: "hsl(var(--muted-foreground))",
    file: "hsl(var(--border))",
    incident: "#ef4444",
    session: "hsl(var(--muted-foreground))",
  }[kind];
}

function kindOrbit(kind: ContextKind): number {
  return { project: 0.18, service: 0.48, incident: 0.68, session: 0.72, note: 0.84, file: 1 }[kind];
}

function relationLength(type: ContextGraphData["edges"][number]["type"]): number {
  return { wiki: 145, "belongs-to": 175, mentions: 160, "depends-on": 140 }[type];
}

function relationDash(type: ContextGraphData["edges"][number]["type"]): string | undefined {
  return { wiki: "4 4", "belongs-to": undefined, mentions: "2 5", "depends-on": undefined }[type];
}

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_295;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundPosition(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeConstellation(points: Array<{ x: number; y: number }>): void {
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const targetRatio = 1.35;
  const currentRatio = width / height;
  const scaleX = currentRatio < 1 / targetRatio ? Math.min(3, height / targetRatio / width) : 1;
  const scaleY = currentRatio > targetRatio ? Math.min(3, width / targetRatio / height) : 1;
  for (const point of points) {
    point.x = centreX + (point.x - centreX) * scaleX;
    point.y = centreY + (point.y - centreY) * scaleY;
  }
}
