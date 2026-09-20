import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background, BackgroundVariant, BaseEdge, Handle, MarkerType, MiniMap, Panel, Position,
  ReactFlow, useNodesState, type Edge, type EdgeProps, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";
import { FileText, FolderGit2, Maximize2, Minimize2, Minus, Network, Pin, Plus, RotateCcw, Scan, Server, StickyNote, TerminalSquare, TriangleAlert } from "lucide-react";
import type { ContextGraph as ContextGraphData, ContextItem, ContextKind, ContextRef } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT, type TranslationKey } from "@/lib/i18n";
import { contextKey, layoutContextNodes, reconcileContextNodes, localContextIds, type ContextFlowNode } from "./context-graph-layout";

export { layoutContextNodes } from "./context-graph-layout";
const KIND_ORDER: ContextKind[] = ["project", "service", "file", "note", "incident", "session"];
const KIND_LABELS: Record<ContextKind, TranslationKey> = {
  project: "context.kindProject", service: "context.kindService", file: "context.kindFile",
  note: "context.kindNote", incident: "context.kindIncident", session: "context.kindSession",
};
const RELATION_LABELS: Record<ContextGraphData["edges"][number]["type"], TranslationKey> = {
  wiki: "context.relationWiki", "belongs-to": "context.relationBelongsTo",
  mentions: "context.relationMentions", "depends-on": "context.relationDependsOn",
};
/**
 * One hue per kind. The icon chip carries it; the node keeps a neutral border so
 * selection still reads as the strongest signal on the canvas.
 *
 * `minimap` repeats the hue as a literal hex because the minimap paints to a
 * canvas element, which cannot resolve a Tailwind class or a CSS variable. The
 * 500 weight is the one that holds up on both the light and dark ground.
 */
const KIND_STYLE: Record<ContextKind, { chip: string; swatch: string; minimap: string }> = {
  project: { chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400", swatch: "bg-violet-500", minimap: "#8b5cf6" },
  service: { chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400", swatch: "bg-sky-500", minimap: "#0ea5e9" },
  file: { chip: "bg-slate-500/10 text-slate-600 dark:text-slate-400", swatch: "bg-slate-500", minimap: "#64748b" },
  note: { chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", swatch: "bg-emerald-500", minimap: "#10b981" },
  incident: { chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400", swatch: "bg-amber-500", minimap: "#f59e0b" },
  session: { chip: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400", swatch: "bg-fuchsia-500", minimap: "#d946ef" },
};
const FIT_OPTIONS = { padding: 0.22, maxZoom: 1 };

export function ContextGraph({ graph, items, onSelect, selected }: {
  graph: ContextGraphData;
  items: ContextItem[];
  onSelect: (item: ContextItem) => void;
  selected?: ContextRef;
}) {
  const t = useT();
  const [scope, setScope] = useState<"local" | "all">("local");
  const [depth, setDepth] = useState(1);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<ContextKind>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance<ContextFlowNode, Edge> | null>(null);
  const initialNodes = useMemo(() => layoutContextNodes(graph, items), [graph, items]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ContextFlowNode>(initialNodes);
  const selectedKey = selected ? contextKey(selected) : null;
  useEffect(() => {
    setNodes((current) => reconcileContextNodes(current, initialNodes));
  }, [initialNodes, setNodes]);
  const related = useMemo(() => {
    if (!selectedKey || !initialNodes.some((node) => node.id === selectedKey)) return null;
    const ids = new Set([selectedKey]);
    for (const edge of graph.edges) {
      const from = contextKey(edge.from);
      const to = contextKey(edge.to);
      if (from === selectedKey) ids.add(to);
      if (to === selectedKey) ids.add(from);
    }
    return ids;
  }, [graph, initialNodes, selectedKey]);
  const localIds = useMemo(() => scope === "local" ? localContextIds(graph, selected, depth) : null, [graph, selected?.kind, selected?.id, scope, depth]);
  const visibleNodes = useMemo(
    () => nodes.filter((node) => !hiddenKinds.has(node.data.item.kind) && (!localIds || localIds.has(node.id))),
    [nodes, localIds, hiddenKinds],
  );
  const displayedNodes = useMemo(() => visibleNodes.map((node) => ({
    ...node,
    selected: node.id === selectedKey,
    zIndex: 2,
    ariaLabel: t("context.graphOpen", { title: node.data.label }),
    data: { ...node.data, dimmed: Boolean(related && !related.has(node.id)) },
  })), [visibleNodes, related, selectedKey, t]);
  const edges = useMemo(() => contextEdges(graph, visibleNodes, related ? selectedKey : null, (type) => t(RELATION_LABELS[type]), hoveredEdge), [graph, visibleNodes, related, selectedKey, t, hoveredEdge]);
  // Fit when filtering changes membership, but preserve the viewport on selection or refresh.
  const membership = displayedNodes.map((node) => node.id).sort().join("\n");
  useEffect(() => {
    if (!flow || !membership) return;
    const frame = requestAnimationFrame(() => { void flow.fitView(FIT_OPTIONS); });
    return () => cancelAnimationFrame(frame);
  }, [flow, membership]);

  useEffect(() => {
    if (!fullscreen) return;
    const leave = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [fullscreen]);
  // The canvas changed size, so what fitted a moment ago no longer does.
  useEffect(() => {
    if (!flow) return;
    const frame = requestAnimationFrame(() => { void flow.fitView(FIT_OPTIONS); });
    return () => cancelAnimationFrame(frame);
  }, [flow, fullscreen]);

  if (!initialNodes.length) {
    return <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground"><Network aria-hidden className="size-7 opacity-50" />{t("context.noMatches")}</div>;
  }

  const canvas = (
    <div className={cn(
      "context-flow flex min-h-0 flex-col overflow-hidden bg-background",
      fullscreen ? "fixed inset-0 z-[1000] h-screen" : "h-full",
    )}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <fieldset className="flex rounded-md border border-border p-0.5" aria-label={t("context.graphScope")}>
          {(["local", "all"] as const).map((value) => <Button key={value} size="sm" variant={scope === value ? "secondary" : "ghost"} aria-pressed={scope === value} onClick={() => setScope(value)}>{t(value === "local" ? "context.graphLocal" : "context.graphAll")}</Button>)}
        </fieldset>
        {scope === "local" ? <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("context.graphDepth")}
          <select className="rounded border border-border bg-background px-2 py-1 text-foreground" value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
            <option value={1}>{t("context.graphOneHop")}</option><option value={2}>{t("context.graphTwoHops")}</option>
          </select>
        </label> : null}
        {scope === "local" && selected ? <span className="min-w-0 truncate text-xs text-muted-foreground">{items.find((item) => contextKey(item.ref) === selectedKey)?.title}</span> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 px-3 py-2">
        <fieldset className="flex flex-1 flex-wrap items-center gap-1" aria-label={t("context.graphFilter")}>
          {KIND_ORDER.filter((kind) => initialNodes.some((node) => node.data.item.kind === kind)).map((kind) => {
            const Icon = kindIcon(kind);
            const hidden = hiddenKinds.has(kind);
            const count = initialNodes.filter((node) => node.data.item.kind === kind).length;
            return (
              <button
                aria-pressed={!hidden}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                  hidden
                    ? "border-dashed border-border text-muted-foreground/60 line-through"
                    : "border-border text-foreground hover:border-muted-foreground/60",
                )}
                key={kind}
                onClick={() => setHiddenKinds((current) => {
                  const next = new Set(current);
                  if (!next.delete(kind)) next.add(kind);
                  return next;
                })}
                title={t(hidden ? "context.graphShowKind" : "context.graphHideKind", { kind: t(KIND_LABELS[kind]) })}
                type="button"
              >
                <span aria-hidden className={cn("size-1.5 rounded-full", hidden ? "bg-muted-foreground/40" : KIND_STYLE[kind].swatch)} />
                <Icon aria-hidden className="size-3" />
                {t(KIND_LABELS[kind])}
                <span className="font-mono tabular-nums text-muted-foreground">{count}</span>
              </button>
            );
          })}
          {hiddenKinds.size ? (
            <Button onClick={() => setHiddenKinds(new Set())} size="sm" variant="ghost">{t("context.graphShowAll")}</Button>
          ) : null}
        </fieldset>
        <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
          {t("context.graphSummary", { nodes: displayedNodes.length, edges: edges.length })}
          {graph.truncated ? ` · ${t("context.graphTruncated")}` : ""}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow<ContextFlowNode, Edge>
          aria-label={t("context.graphAria")}
          edges={edges} edgeTypes={EDGE_TYPES}
          ariaLabelConfig={{ "node.a11yDescription.default": t("context.graphKeyboard"), "node.a11yDescription.keyboardDisabled": t("context.graphKeyboard") }}
          onKeyDownCapture={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            const element = event.target instanceof Element ? event.target.closest(".react-flow__node") : null;
            const node = nodes.find((entry) => entry.id === element?.getAttribute("data-id"));
            if (node) { event.preventDefault(); event.stopPropagation(); onSelect(node.data.item); }
          }}
          onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.id)}
          onEdgeMouseLeave={() => setHoveredEdge(null)}
          edgesFocusable={false}
          fitView fitViewOptions={FIT_OPTIONS} maxZoom={1.8} minZoom={0.15}
          nodeTypes={NODE_TYPES} nodes={displayedNodes} nodesConnectable={false}
          nodesFocusable onInit={setFlow} onNodeClick={(_, node) => onSelect(node.data.item)}
          onNodesChange={onNodesChange} onlyRenderVisibleElements panOnScroll
          proOptions={{ hideAttribution: true }} zoomOnDoubleClick={false}
          deleteKeyCode={null}
        >
          <Background color="hsl(var(--border))" gap={24} size={1} variant={BackgroundVariant.Dots} />
          <Panel className="context-flow-toolbar" position="bottom-left">
            <Button aria-label={t("context.graphZoomIn")} title={t("context.graphZoomIn")} variant="ghost" size="icon-sm" onClick={() => void flow?.zoomIn()}><Plus aria-hidden /></Button>
            <Button aria-label={t("context.graphZoomOut")} title={t("context.graphZoomOut")} variant="ghost" size="icon-sm" onClick={() => void flow?.zoomOut()}><Minus aria-hidden /></Button>
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            <Button aria-label={t("context.graphFit")} title={t("context.graphFit")} variant="ghost" size="icon-sm" onClick={() => void flow?.fitView(FIT_OPTIONS)}><Scan aria-hidden /></Button>
            <Button aria-label={t("context.graphReset")} title={t("context.graphReset")} variant="ghost" size="icon-sm" onClick={() => {
              setNodes(initialNodes);
              requestAnimationFrame(() => { void flow?.fitView(FIT_OPTIONS); });
            }}><RotateCcw aria-hidden /></Button>
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            <Button
              aria-label={t(fullscreen ? "context.graphExitFullscreen" : "context.graphFullscreen")}
              onClick={() => setFullscreen((value) => !value)}
              size="icon-sm"
              title={t(fullscreen ? "context.graphExitFullscreen" : "context.graphFullscreen")}
              variant="ghost"
            >{fullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}</Button>
          </Panel>
          {displayedNodes.length > 16 ? <MiniMap ariaLabel={t("context.graphMinimap")} maskColor="hsl(var(--background) / 0.8)" nodeColor={(node) => KIND_STYLE[(node as ContextFlowNode).data.item.kind].minimap} nodeBorderRadius={4} pannable position="bottom-right" zoomable /> : null}
        </ReactFlow>
      </div>
    </div>
  );
  return fullscreen ? createPortal(canvas, document.body) : canvas;
}

export function contextEdges(graph: ContextGraphData, nodes: ContextFlowNode[], selectedKey: string | null, label: (type: ContextGraphData["edges"][number]["type"]) => string, hoveredEdge: string | null = null): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedEdges = graph.edges.filter((edge) => contextKey(edge.from) === selectedKey || contextKey(edge.to) === selectedKey);
  const labeledRelations = new Set<string>();
  const routeY = (nodes.length ? Math.min(...nodes.map((node) => node.position.y)) : 0) - 80;
  return graph.edges.flatMap((edge) => {
    const source = byId.get(contextKey(edge.from));
    const target = byId.get(contextKey(edge.to));
    if (!source || !target) return [];
    const skipsLane = Math.abs(source.position.x - target.position.x) > 400;
    const id = `${source.id}>${target.id}:${edge.type}`;
    const active = source.id === selectedKey || target.id === selectedKey;
    const showLabel = id === hoveredEdge || (active && (selectedEdges.length <= 6 || !labeledRelations.has(edge.type)));
    if (active) labeledRelations.add(edge.type);
    const horizontal = source.position.x !== target.position.x;
    const forwards = horizontal ? source.position.x < target.position.x : source.position.y < target.position.y;
    const color = active ? "hsl(var(--foreground) / 0.55)" : "hsl(var(--muted-foreground) / 0.35)";
    return [{
      id, source: source.id, target: target.id,
      sourceHandle: skipsLane ? "source-top" : source.id === target.id ? "source-right" : horizontal ? (forwards ? "source-right" : "source-left") : (forwards ? "source-bottom" : "source-top"),
      targetHandle: skipsLane || source.id === target.id ? "target-top" : horizontal ? (forwards ? "target-left" : "target-right") : (forwards ? "target-top" : "target-bottom"),
      type: skipsLane ? "context-arc" : "default", data: { routeY }, ariaLabel: label(edge.type), label: showLabel ? label(edge.type) : undefined,
      labelStyle: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
      labelBgStyle: { fill: "hsl(var(--background))" }, labelBgPadding: [6, 4] as [number, number], labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
      style: { stroke: color, strokeWidth: active ? 1.5 : 1, strokeDasharray: edge.type === "mentions" || edge.type === "wiki" ? "4 4" : undefined, opacity: selectedKey && !active ? 0.35 : 1 },
      zIndex: active ? 1 : 0,
    }];
  });
}

function ContextNode({ data, selected }: NodeProps<ContextFlowNode>) {
  const t = useT();
  const { item, label } = data;
  const Icon = kindIcon(item.kind);
  return (
    <div className={cn(
      "flex h-16 w-[240px] items-center gap-3 rounded-lg border bg-background px-3 text-foreground transition-[border-color,opacity] duration-150 motion-reduce:transition-none",
      selected ? "border-foreground ring-1 ring-foreground/10" : "border-border hover:border-muted-foreground/60",
      data.dimmed && "opacity-75 hover:opacity-100",
    )} title={`${label}${item.path ? `\n${item.path}` : ""}`}>
      {([Position.Left, Position.Right, Position.Top, Position.Bottom] as const).flatMap((position) => (["source", "target"] as const).map((type) => <Handle className="!size-1 !border-0 !bg-transparent" id={`${type}-${position}`} key={`${type}-${position}`} position={position} type={type} />))}
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-md", selected ? "bg-foreground text-background" : KIND_STYLE[item.kind].chip)}><Icon aria-hidden className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium leading-5">{label}</span>
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {t(KIND_LABELS[item.kind])}<span aria-hidden>·</span><span className="font-mono tabular-nums" title={t("context.graphConnections", { count: data.connections })}>{data.connections}</span>
        </span>
      </span>
      {item.pinned ? <Pin aria-label={t("context.pinned")} className="size-3 shrink-0 text-muted-foreground" /> : null}
    </div>
  );
}

function ContextArcEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data } = props;
  const routeY = typeof data?.routeY === "number" ? data.routeY : Math.min(sourceY, targetY) - 80;
  return <BaseEdge
    id={props.id}
    path={`M ${sourceX},${sourceY} C ${sourceX},${routeY} ${targetX},${routeY} ${targetX},${targetY}`}
    markerEnd={props.markerEnd} style={props.style}
    label={props.label} labelX={(sourceX + targetX) / 2} labelY={(sourceY + targetY) / 8 + routeY * 0.75}
    labelStyle={props.labelStyle} labelBgStyle={props.labelBgStyle} labelBgPadding={props.labelBgPadding} labelBgBorderRadius={props.labelBgBorderRadius}
  />;
}

const EDGE_TYPES = { "context-arc": ContextArcEdge };
const NODE_TYPES = { context: ContextNode };
function kindIcon(kind: ContextKind) {
  return { note: StickyNote, project: FolderGit2, service: Server, file: FileText, incident: TriangleAlert, session: TerminalSquare }[kind];
}
