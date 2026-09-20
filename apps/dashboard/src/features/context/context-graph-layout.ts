import type { Node } from "@xyflow/react";
import type { ContextGraph, ContextItem, ContextRef } from "@/lib/api";

export const CONTEXT_NODE_WIDTH = 240;
export const CONTEXT_NODE_HEIGHT = 64;
const ROW_GAP = 28;
const COLUMN_GAP = 104;
const GROUP_GAP = 96;
const LANE = { project: 0, service: 1, file: 2, note: 2, incident: 3, session: 3 };

export interface ContextNodeData extends Record<string, unknown> {
  item: ContextItem;
  label: string;
  connections: number;
  dimmed?: boolean;
}
export type ContextFlowNode = Node<ContextNodeData, "context">;
export const contextKey = (ref: ContextRef) => `${ref.kind}:${ref.id}`;

/** Group related context, then arrange it in compact, non-overlapping lanes. */
export function layoutContextNodes(graph: ContextGraph, items: ContextItem[]): ContextFlowNode[] {
  const itemByKey = new Map(items.map((item) => [contextKey(item.ref), item]));
  const records = [...new Map(graph.nodes.map((node) => [contextKey(node.ref), node])).values()]
    .filter((node) => itemByKey.has(contextKey(node.ref)))
    .sort((a, b) => LANE[a.kind] - LANE[b.kind] || a.title.localeCompare(b.title) || contextKey(a.ref).localeCompare(contextKey(b.ref)));
  const neighbors = new Map(records.map((node) => [contextKey(node.ref), new Set<string>()]));
  for (const edge of graph.edges) {
    const from = contextKey(edge.from);
    const to = contextKey(edge.to);
    if (from !== to && neighbors.has(from) && neighbors.has(to)) {
      neighbors.get(from)?.add(to);
      neighbors.get(to)?.add(from);
    }
  }
  // Project membership also groups isolated records, without inventing graph edges.
  const groupNeighbors = new Map([...neighbors].map(([id, adjacent]) => [id, new Set(adjacent)]));
  const projectAnchor = new Map<string, string>();
  for (const record of records) {
    const id = contextKey(record.ref);
    const path = itemByKey.get(id)?.projectPath;
    if (!path) continue;
    const anchor = projectAnchor.get(path);
    if (anchor) {
      groupNeighbors.get(id)?.add(anchor);
      groupNeighbors.get(anchor)?.add(id);
    } else projectAnchor.set(path, id);
  }
  const recordById = new Map(records.map((record) => [contextKey(record.ref), record]));
  const visited = new Set<string>();
  const groups: typeof records[] = [];
  for (const record of records) {
    const id = contextKey(record.ref);
    if (visited.has(id)) continue;
    const pending = [id];
    const group: typeof records = [];
    visited.add(id);
    for (let i = 0; i < pending.length; i += 1) {
      const current = recordById.get(pending[i]);
      if (current) group.push(current);
      for (const neighbor of groupNeighbors.get(pending[i]) ?? []) {
        if (!visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
      }
    }
    groups.push(group);
  }

  const result: ContextFlowNode[] = [];
  let groupX = 0;
  let groupY = 0;
  let shelfHeight = 0;
  const shelfWidth = Math.max(1000, Math.sqrt(records.length) * 240);
  for (const group of groups) {
    const rows = Math.max(4, Math.ceil(Math.sqrt(group.length) * 1.4));
    const height = Math.min(rows, Math.max(...[0, 1, 2, 3].map((lane) => group.filter((node) => LANE[node.kind] === lane).length))) * (CONTEXT_NODE_HEIGHT + ROW_GAP) - ROW_GAP;
    const positions = new Map<string, { x: number; y: number }>();
    let laneX = 0;
    for (const lane of [0, 1, 2, 3]) {
      const laneNodes = group.filter((node) => LANE[node.kind] === lane);
      if (!laneNodes.length) continue;
      const neighborY = (ref: ContextRef) => {
        const ys = [...(neighbors.get(contextKey(ref)) ?? [])].flatMap((id) => {
          const position = positions.get(id);
          return position ? [position.y] : [];
        });
        return ys.length ? ys.reduce((sum, y) => sum + y, 0) / ys.length : height / 2;
      };
      laneNodes.sort((a, b) => neighborY(a.ref) - neighborY(b.ref) || a.title.localeCompare(b.title) || contextKey(a.ref).localeCompare(contextKey(b.ref)));
      const columns = Math.ceil(laneNodes.length / rows);
      for (const [index, node] of laneNodes.entries()) {
        const column = Math.floor(index / rows);
        const columnRows = Math.min(rows, laneNodes.length - column * rows);
        positions.set(contextKey(node.ref), {
          x: laneX + column * (CONTEXT_NODE_WIDTH + COLUMN_GAP),
          y: (height - (columnRows * (CONTEXT_NODE_HEIGHT + ROW_GAP) - ROW_GAP)) / 2 + (index % rows) * (CONTEXT_NODE_HEIGHT + ROW_GAP),
        });
      }
      laneX += columns * (CONTEXT_NODE_WIDTH + COLUMN_GAP);
    }
    const width = laneX - COLUMN_GAP;
    if (groupX > 0 && groupX + width > shelfWidth) {
      groupX = 0;
      groupY += shelfHeight + GROUP_GAP;
      shelfHeight = 0;
    }
    for (const record of group) {
      const id = contextKey(record.ref);
      const item = itemByKey.get(id);
      const position = positions.get(id);
      if (!item || !position) continue;
      result.push({
        id,
        type: "context",
        position: { x: groupX + position.x, y: groupY + position.y },
        data: { item, label: record.title, connections: neighbors.get(id)?.size ?? 0 },
        width: CONTEXT_NODE_WIDTH,
        height: CONTEXT_NODE_HEIGHT,
      });
    }
    groupX += width + GROUP_GAP;
    shelfHeight = Math.max(shelfHeight, height);
  }
  return result;
}

/** Refresh labels and membership without snapping a user's dragged nodes back. */
export function reconcileContextNodes(previous: ContextFlowNode[], incoming: ContextFlowNode[]): ContextFlowNode[] {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  const sameMembership = previous.length === incoming.length && incoming.every((node) => previousById.has(node.id));
  return incoming.map((node) => {
    const previousNode = previousById.get(node.id);
    return sameMembership && previousNode ? { ...node, position: previousNode.position } : node;
  });
}

/** Traverse both directions without bridging through unavailable nodes. */
export function localContextIds(graph: ContextGraph, selected: ContextRef | undefined, depth: number): Set<string> | null {
  const available = new Set(graph.nodes.map((node) => contextKey(node.ref)));
  if (!selected || !available.has(contextKey(selected))) return null;
  const adjacent = new Map([...available].map((id) => [id, new Set<string>()]));
  for (const edge of graph.edges) {
    const from = contextKey(edge.from);
    const to = contextKey(edge.to);
    if (available.has(from) && available.has(to)) {
      adjacent.get(from)?.add(to);
      adjacent.get(to)?.add(from);
    }
  }
  const visited = new Set([contextKey(selected)]);
  let frontier = [...visited];
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next: string[] = [];
    for (const id of frontier) for (const neighbor of adjacent.get(id) ?? []) {
      if (!visited.has(neighbor)) { visited.add(neighbor); next.push(neighbor); }
    }
    frontier = next;
  }
  return visited;
}
