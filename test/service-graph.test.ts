import { describe, expect, test } from "vitest";
import {
  buildServiceGraph,
  DependencyCycleError,
  resolveStartOrder,
} from "../src/core/service-graph.js";
import type { ServiceDefinition } from "../src/core/types.js";

function svc(name: string, dependsOn?: string[]): ServiceDefinition {
  return { name, command: "true", cwd: "/tmp", dependsOn };
}

describe("buildServiceGraph", () => {
  test("topologically orders deps before dependents", () => {
    const graph = buildServiceGraph([
      svc("api", ["db"]),
      svc("web", ["api"]),
      svc("db"),
    ]);
    expect(graph.cycles).toEqual([]);
    expect(graph.order.indexOf("db")).toBeLessThan(graph.order.indexOf("api"));
    expect(graph.order.indexOf("api")).toBeLessThan(graph.order.indexOf("web"));
  });

  test("flags unknown dependencies as missing, not edges", () => {
    const graph = buildServiceGraph([svc("api", ["ghost"])]);
    const api = graph.nodes.find((node) => node.name === "api");
    expect(api?.dependsOn).toEqual([]);
    expect(api?.missing).toEqual(["ghost"]);
    expect(graph.edges).toEqual([]);
  });

  test("ignores a self-reference", () => {
    const graph = buildServiceGraph([svc("api", ["api", "db"]), svc("db")]);
    const api = graph.nodes.find((node) => node.name === "api");
    expect(api?.dependsOn).toEqual(["db"]);
    expect(api?.missing).toEqual([]);
  });

  test("detects a cycle and yields no order", () => {
    const graph = buildServiceGraph([svc("a", ["b"]), svc("b", ["a"])]);
    expect(graph.order).toEqual([]);
    expect(graph.cycles.length).toBe(1);
    expect(graph.cycles[0].slice().sort()).toEqual(["a", "b"]);
  });
});

describe("resolveStartOrder", () => {
  test("expands to include transitive deps not in the request", () => {
    const services = [svc("web", ["api"]), svc("api", ["db"]), svc("db")];
    const order = resolveStartOrder(services, ["web"]);
    expect(order).toEqual(["db", "api", "web"]);
  });

  test("skips unknown deps without throwing", () => {
    const order = resolveStartOrder([svc("web", ["ghost"])], ["web"]);
    expect(order).toEqual(["web"]);
  });

  test("throws DependencyCycleError on a cycle in the requested set", () => {
    const services = [svc("a", ["b"]), svc("b", ["a"])];
    expect(() => resolveStartOrder(services, ["a"])).toThrow(DependencyCycleError);
  });
});
