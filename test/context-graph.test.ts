import { describe, expect, test } from "vitest";
import { contextEdges } from "../apps/dashboard/src/features/context/context-graph";
import { layoutContextNodes, reconcileContextNodes, localContextIds, CONTEXT_NODE_WIDTH, CONTEXT_NODE_HEIGHT } from "../apps/dashboard/src/features/context/context-graph-layout";
import type { ContextGraph, ContextItem, ContextKind } from "../apps/dashboard/src/lib/api/context-api";

function item(kind: ContextKind, id: string): ContextItem {
  return { ref: { kind, id }, title: id, kind, tags: [], aliases: [], pinned: false, editable: false };
}
const project = item("project", "/repo");
const service = item("service", "/repo:api");
const items = [project, service];
function graphOf(entries: ContextItem[], edges: ContextGraph["edges"] = []): ContextGraph {
  return { nodes: entries.map((entry) => ({ ref: entry.ref, title: entry.title, kind: entry.kind, pinned: entry.pinned })), edges, truncated: false };
}

describe("Context graph layout", () => {
  test("keeps related entities in stable lanes regardless of API ordering", () => {
    const graph = graphOf(items, [{ from: service.ref, to: project.ref, type: "belongs-to" }]);
    const nodes = layoutContextNodes(graph, items);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.data.item).toBe(project);
    expect(nodes[0]?.position.x).toBeLessThan(nodes[1]?.position.x ?? 0);
    const positions = (entries: typeof nodes) => Object.fromEntries(entries.map((node) => [node.id, node.position]));
    expect(positions(nodes)).toEqual(positions(layoutContextNodes({ ...graph, nodes: [...graph.nodes].reverse() }, [...items].reverse())));
  });

  test("packs a large mixed graph without overlapping cards, including disconnected items", () => {
    const entries = [project, ...Array.from({ length: 60 }, (_, index) => item(index % 3 === 0 ? "note" : "file", `context-${index}`))];
    const graph = graphOf(entries, entries.slice(1, 45).map((entry) => ({ from: entry.ref, to: project.ref, type: "belongs-to" })));
    const nodes = layoutContextNodes(graph, entries);
    expect(nodes).toHaveLength(entries.length);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i].position;
        const b = nodes[j].position;
        expect(Math.abs(a.x - b.x) >= CONTEXT_NODE_WIDTH || Math.abs(a.y - b.y) >= CONTEXT_NODE_HEIGHT).toBe(true);
      }
    }
  });

  test("omits unavailable nodes and edges and handles an empty graph", () => {
    const missing = item("note", "missing");
    const graph = graphOf([project, missing], [{ from: missing.ref, to: project.ref, type: "wiki" }]);
    const nodes = layoutContextNodes(graph, items);
    expect(nodes).toHaveLength(1);
    expect(contextEdges(graph, nodes, null, (type) => type)).toEqual([]);
    expect(layoutContextNodes(graphOf([]), [])).toEqual([]);
  });

  test("preserves dragged positions on content refresh and relayouts changed membership", () => {
    const initial = layoutContextNodes(graphOf(items), items);
    const dragged = initial.map((node) => ({ ...node, position: { x: node.position.x + 99, y: node.position.y + 71 } }));
    const incoming = initial.map((node) => ({ ...node, data: { ...node.data, label: "Updated" } }));
    const refreshed = reconcileContextNodes(dragged, incoming);
    expect(refreshed.map((node) => node.position)).toEqual(dragged.map((node) => node.position));
    expect(refreshed[0]?.data.label).toBe("Updated");
    expect(reconcileContextNodes(dragged, initial.slice(0, 1))).toEqual(initial.slice(0, 1));
  });

  test("routes long relations around intervening lanes and reveals only selected relation labels", () => {
    const note = item("note", "Architecture");
    const entries = [project, service, note];
    const graph = graphOf(entries, [
      { from: service.ref, to: project.ref, type: "belongs-to" },
      { from: note.ref, to: project.ref, type: "belongs-to" },
      { from: note.ref, to: service.ref, type: "wiki" },
    ]);
    const nodes = layoutContextNodes(graph, entries);
    const edges = contextEdges(graph, nodes, "note:Architecture", (type) => type);
    expect(edges[0]?.label).toBeUndefined();
    expect(edges[1]).toMatchObject({ type: "context-arc", sourceHandle: "source-top", targetHandle: "target-top", label: "belongs-to" });
    expect(edges[2]).toMatchObject({ type: "default", sourceHandle: "source-left", targetHandle: "target-right", label: "wiki" });
    expect(contextEdges(graph, nodes, null, (type) => type).every((edge) => edge.label === undefined)).toBe(true);
  });
  test("keeps dense selections readable and reveals individual labels on hover", () => {
    const files = Array.from({ length: 12 }, (_, index) => item("file", `file-${index}`));
    const graph = graphOf([project, ...files], files.map((file) => ({ from: file.ref, to: project.ref, type: "belongs-to" })));
    const nodes = layoutContextNodes(graph, [project, ...files]);
    const edges = contextEdges(graph, nodes, "project:/repo", (type) => type);
    expect(edges.filter((edge) => edge.label)).toHaveLength(1);
    const hovered = edges[4];
    expect(contextEdges(graph, nodes, "project:/repo", (type) => type, hovered.id)[4].label).toBe("belongs-to");
  });

});

describe("Local context graph", () => {
  test("follows incoming and outgoing links by depth without including disconnected nodes", () => {
    const note = item("note", "decision");
    const orphan = item("note", "orphan");
    const graph = graphOf([project, service, note, orphan], [
      { from: service.ref, to: project.ref, type: "belongs-to" },
      { from: note.ref, to: service.ref, type: "wiki" },
      { from: service.ref, to: note.ref, type: "mentions" },
    ]);
    expect(localContextIds(graph, project.ref, 1)).toEqual(new Set(["project:/repo", "service:/repo:api"]));
    expect(localContextIds(graph, project.ref, 2)).toEqual(new Set(["project:/repo", "service:/repo:api", "note:decision"]));
    expect(localContextIds(graph, orphan.ref, 2)).toEqual(new Set(["note:orphan"]));
    expect(localContextIds(graph, undefined, 1)).toBeNull();
  });

  test("does not traverse missing nodes to connect unrelated visible nodes", () => {
    const missing = item("note", "missing");
    const graph = graphOf(items, [
      { from: project.ref, to: missing.ref, type: "wiki" },
      { from: missing.ref, to: service.ref, type: "wiki" },
    ]);
    expect(localContextIds(graph, project.ref, 2)).toEqual(new Set(["project:/repo"]));
    expect(localContextIds(graph, missing.ref, 1)).toBeNull();
  });
});
