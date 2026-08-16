import { describe, expect, test } from "vitest";
import { layoutContextNodes } from "../src/web/client/src/features/context/context-graph";
import type { ContextGraph, ContextItem } from "../src/web/client/src/lib/api/context-api";

const items: ContextItem[] = [
  {
    ref: { kind: "project", id: "/repo" },
    title: "Repository",
    kind: "project",
    tags: [],
    aliases: [],
    pinned: false,
    editable: false,
  },
  {
    ref: { kind: "service", id: "/repo:api" },
    title: "API",
    kind: "service",
    tags: [],
    aliases: [],
    pinned: false,
    editable: false,
  },
];

describe("Context graph layout", () => {
  test("places entities in a stable geometric constellation and keeps their backing items", () => {
    const graph: ContextGraph = {
      nodes: items.map((item) => ({ ref: item.ref, title: item.title, kind: item.kind, pinned: false })),
      edges: [{ from: items[1]!.ref, to: items[0]!.ref, type: "belongs-to" }],
      truncated: false,
    };

    const nodes = layoutContextNodes(graph, items);
    const repeated = layoutContextNodes(graph, items);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.data.item).toBe(items[0]);
    expect(nodes.map((node) => node.position)).toEqual(repeated.map((node) => node.position));
    expect(nodes[1]?.position).not.toEqual(nodes[0]?.position);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
  });

  test("does not render graph records whose source item is unavailable", () => {
    const graph: ContextGraph = {
      nodes: [
        { ref: items[0]!.ref, title: items[0]!.title, kind: items[0]!.kind, pinned: false },
        { ref: { kind: "note", id: "missing" }, title: "Missing", kind: "note", pinned: false },
      ],
      edges: [],
      truncated: false,
    };

    expect(layoutContextNodes(graph, items)).toHaveLength(1);
  });
});
