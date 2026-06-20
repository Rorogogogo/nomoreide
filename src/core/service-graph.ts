import type { ServiceDefinition } from "./types.js";

/**
 * Pure dependency-graph helpers for service startup ordering (IDEAS #9).
 *
 * Services declare `dependsOn: string[]`; this module turns those declarations
 * into a topologically sorted start order and surfaces the two things that can
 * go wrong — unknown references and cycles — without throwing, so the UI can
 * render them. `ProcessManager` uses {@link resolveStartOrder} to sequence a
 * bundle start (and its reverse to stop).
 */

export interface ServiceGraphNode {
  name: string;
  /** Declared deps that resolve to a registered service. */
  dependsOn: string[];
  /** Declared deps with no matching service (rendered as a warning). */
  missing: string[];
}

export interface ServiceGraphCycleError {
  /** Names participating in a dependency cycle. */
  cycle: string[];
}

export interface ServiceGraph {
  nodes: ServiceGraphNode[];
  /** All edges as `[from -> dependsOn]` pairs over registered services. */
  edges: Array<{ from: string; to: string }>;
  /** Topological start order (deps first); empty when a cycle blocks sorting. */
  order: string[];
  /** Distinct cycles detected in the graph (empty when acyclic). */
  cycles: string[][];
}

type GraphService = Pick<ServiceDefinition, "name" | "dependsOn">;

/** Thrown by {@link resolveStartOrder} when the requested set contains a cycle. */
export class DependencyCycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`Service dependency cycle detected: ${cycle.join(" → ")}.`);
    this.name = "DependencyCycleError";
    this.cycle = cycle;
  }
}

/** Build the full graph for every registered service (used by the UI panel). */
export function buildServiceGraph(services: GraphService[]): ServiceGraph {
  const registered = new Set(services.map((service) => service.name));
  const nodes: ServiceGraphNode[] = services.map((service) => {
    const declared = dedupe(service.dependsOn ?? []).filter((dep) => dep !== service.name);
    return {
      name: service.name,
      dependsOn: declared.filter((dep) => registered.has(dep)),
      missing: declared.filter((dep) => !registered.has(dep)),
    };
  });

  const edges = nodes.flatMap((node) =>
    node.dependsOn.map((to) => ({ from: node.name, to })),
  );
  const { order, cycles } = topoSort(nodes);
  return { nodes, edges, order, cycles };
}

/**
 * Resolve the start order for `requested` services, expanding to include any
 * transitive dependencies that are also registered. Deps come before the
 * services that need them. Throws {@link DependencyCycleError} if the expanded
 * set contains a cycle. Unknown deps are silently skipped (they surface in the
 * UI graph instead — a missing dependency shouldn't block a manual bundle run).
 */
export function resolveStartOrder(
  services: GraphService[],
  requested: string[],
): string[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  const wanted = new Set<string>();

  const visit = (name: string) => {
    if (wanted.has(name)) return;
    const service = byName.get(name);
    if (!service) return; // not registered → caller handles the error on start
    wanted.add(name);
    for (const dep of service.dependsOn ?? []) {
      if (dep !== name) visit(dep);
    }
  };
  for (const name of requested) visit(name);

  const subset = buildServiceGraph(
    services.filter((service) => wanted.has(service.name)),
  );
  if (subset.cycles.length > 0) {
    throw new DependencyCycleError(subset.cycles[0]);
  }
  return subset.order;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Kahn's algorithm. Returns the topological `order` and, for any nodes left
 * unsorted (i.e. inside a cycle), the distinct `cycles` extracted via DFS.
 */
function topoSort(nodes: ServiceGraphNode[]): {
  order: string[];
  cycles: string[][];
} {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.name, 0);
    dependents.set(node.name, []);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      // dep must run before node → edge dep -> node.
      inDegree.set(node.name, (inDegree.get(node.name) ?? 0) + 1);
      dependents.get(dep)?.push(node.name);
    }
  }

  const queue = nodes.filter((node) => inDegree.get(node.name) === 0).map((node) => node.name);
  const order: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    order.push(name);
    for (const next of dependents.get(name) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length === nodes.length) {
    return { order, cycles: [] };
  }

  // Nodes not emitted are part of one or more cycles. A topo sort can't order
  // them, so callers should treat `order` as invalid when `cycles` is non-empty.
  const stuck = new Set(nodes.map((node) => node.name).filter((name) => !order.includes(name)));
  return { order: [], cycles: findCycles(nodes, stuck) };
}

/** DFS over the unsorted nodes to extract concrete cycle paths for display. */
function findCycles(nodes: ServiceGraphNode[], stuck: Set<string>): string[][] {
  const depMap = new Map(nodes.map((node) => [node.name, node.dependsOn]));
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const dfs = (name: string) => {
    if (!stuck.has(name)) return;
    stack.push(name);
    onStack.add(name);
    for (const dep of depMap.get(name) ?? []) {
      if (!stuck.has(dep)) continue;
      if (onStack.has(dep)) {
        const start = stack.indexOf(dep);
        if (start !== -1) cycles.push(stack.slice(start));
      } else if (!seen.has(dep)) {
        dfs(dep);
      }
    }
    stack.pop();
    onStack.delete(name);
    seen.add(name);
  };

  for (const name of stuck) {
    if (!seen.has(name)) dfs(name);
  }
  return dedupeCycles(cycles);
}

/** Collapse rotations/duplicates so the same cycle is reported once. */
function dedupeCycles(cycles: string[][]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const cycle of cycles) {
    const key = [...cycle].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cycle);
  }
  return result;
}
