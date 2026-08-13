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
const COL_W = 236;
const ROW_H = 74;
const PAD = 48;
const MAX_ROWS_PER_COLUMN = 8;
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
  const edges = useMemo(() => contextEdges(graph), [graph]);
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
        defaultEdgeOptions={{ type: "smoothstep" }}
        edges={edges}
        elevateEdgesOnSelect
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
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
        <Background color="hsl(var(--border))" gap={22} size={1} variant={BackgroundVariant.Dots} />
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
              <span className="flex items-center gap-1 text-[9px] text-muted-foreground" key={kind}>
                <span className={cn("size-1.5 rounded-full", kindDot(kind))} />
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
  const rowsByKind = new Map<ContextKind, number>();
  const countsByKind = new Map<ContextKind, number>();
  for (const node of graph.nodes) countsByKind.set(node.kind, (countsByKind.get(node.kind) ?? 0) + 1);
  const baseColumnByKind = new Map<ContextKind, number>();
  let nextColumn = 0;
  for (const kind of KIND_ORDER) {
    const count = countsByKind.get(kind) ?? 0;
    if (!count) continue;
    baseColumnByKind.set(kind, nextColumn);
    nextColumn += Math.ceil(count / MAX_ROWS_PER_COLUMN);
  }
  const maxRows = Math.min(MAX_ROWS_PER_COLUMN, Math.max(1, ...countsByKind.values()));

  return graph.nodes.flatMap((node) => {
    const item = itemByKey.get(key(node.ref));
    if (!item) return [];
    const index = rowsByKind.get(node.kind) ?? 0;
    rowsByKind.set(node.kind, index + 1);
    const localColumn = Math.floor(index / MAX_ROWS_PER_COLUMN);
    const column = (baseColumnByKind.get(node.kind) ?? 0) + localColumn;
    const row = index % MAX_ROWS_PER_COLUMN;
    const count = countsByKind.get(node.kind) ?? 1;
    const rowsInColumn = Math.min(MAX_ROWS_PER_COLUMN, count - localColumn * MAX_ROWS_PER_COLUMN);
    const centeredOffset = ((maxRows - rowsInColumn) * ROW_H) / 2;
    return [{
      id: key(node.ref),
      type: "context",
      position: { x: PAD + column * COL_W, y: PAD + centeredOffset + row * ROW_H },
      data: { item, label: node.title },
      width: NODE_W,
    } satisfies ContextFlowNode];
  });
}

function contextEdges(graph: ContextGraphData): Edge[] {
  return graph.edges.map((edge) => ({
    id: `${key(edge.from)}>${key(edge.to)}:${edge.type}`,
    source: key(edge.from),
    target: key(edge.to),
    ariaLabel: edge.type,
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
    style: { strokeWidth: 1.25 },
  }));
}

const NODE_TYPES = { context: ContextNode };

function ContextNode({ data, selected }: NodeProps<ContextFlowNode>) {
  const { item, label } = data;
  const Icon = kindIcon(item.kind);
  return (
    <div
      className={cn(
        "group flex h-11 w-[168px] items-center gap-2 rounded-md border bg-card px-2.5 text-foreground shadow-sm transition-[border-color,background-color] duration-150 motion-reduce:transition-none",
        selected ? "border-foreground bg-muted/60" : "border-border hover:border-muted-foreground/60",
      )}
      title={`${label} · ${item.kind}`}
    >
      <Handle className="!size-1.5 !border-background !bg-border" position={Position.Left} type="target" />
      <span className={cn("grid size-6 shrink-0 place-items-center rounded-sm", kindSurface(item.kind))}>
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[10px] font-medium leading-tight">{label}</span>
        <span className="mt-0.5 block truncate font-mono text-[8px] text-muted-foreground">{item.kind}</span>
      </span>
      {item.pinned ? <Pin aria-label="Pinned" className="size-3 shrink-0 text-amber-500" /> : null}
      <Handle className="!size-1.5 !border-background !bg-border" position={Position.Right} type="source" />
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

function kindDot(kind: ContextKind): string {
  return {
    note: "bg-sky-500",
    project: "bg-emerald-500",
    service: "bg-violet-500",
    file: "bg-zinc-500",
    incident: "bg-rose-500",
    session: "bg-amber-500",
  }[kind];
}

function kindSurface(kind: ContextKind): string {
  return {
    note: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    project: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    service: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    file: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
    incident: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    session: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  }[kind];
}

function minimapColor(kind: ContextKind): string {
  return {
    note: "#0ea5e9",
    project: "#10b981",
    service: "#8b5cf6",
    file: "#71717a",
    incident: "#f43f5e",
    session: "#f59e0b",
  }[kind];
}
