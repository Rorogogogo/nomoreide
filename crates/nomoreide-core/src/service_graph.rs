//! Service dependency ordering (mirrors `src/core/service-graph.ts`).
//!
//! Services declare `dependsOn`; this turns those declarations into a
//! topological start order so dependencies come up before dependents. Used by
//! the `start_bundle` / `stop_bundle` commands. Unknown deps and self-refs are
//! ignored; a cycle is reported as an `Err` so the caller can refuse to start.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::config::ServiceDef;

/// One service as the dependency panel renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceGraphNode {
    pub name: String,
    /// Declared deps that resolve to a registered service.
    pub depends_on: Vec<String>,
    /// Declared deps with no matching service, shown as a warning rather than
    /// dropped: a typo in a `dependsOn` should be visible, not silent.
    pub missing: Vec<String>,
}

/// A `from -> to` edge over registered services only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceGraphEdge {
    pub from: String,
    pub to: String,
}

/// The whole graph, for the panel that draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceGraph {
    pub nodes: Vec<ServiceGraphNode>,
    pub edges: Vec<ServiceGraphEdge>,
    /// Topological start order, dependencies first. **Empty when `cycles` is
    /// not**, because a graph with a cycle has no valid order at all — the
    /// panel must read `cycles` before it trusts this.
    pub order: Vec<String>,
    /// Distinct cycles, each as the path around it.
    pub cycles: Vec<Vec<String>>,
}

/// Build the full graph for every registered service.
///
/// Per node the declared deps are deduplicated and a self-reference is dropped
/// before anything else, so `dependsOn: ["a", "a", "self"]` on `self` is one
/// edge, not three. What remains splits into deps that resolve and deps that do
/// not; only the former become edges.
pub fn build_service_graph(services: &[ServiceDef]) -> ServiceGraph {
    let registered: HashSet<&str> = services.iter().map(|s| s.name.as_str()).collect();

    let nodes: Vec<ServiceGraphNode> = services
        .iter()
        .map(|service| {
            let mut seen = HashSet::new();
            let declared: Vec<&String> = service
                .depends_on
                .iter()
                .flatten()
                .filter(|dep| **dep != service.name)
                .filter(|dep| seen.insert((*dep).clone()))
                .collect();
            ServiceGraphNode {
                name: service.name.clone(),
                depends_on: declared
                    .iter()
                    .filter(|dep| registered.contains(dep.as_str()))
                    .map(|dep| (*dep).clone())
                    .collect(),
                missing: declared
                    .iter()
                    .filter(|dep| !registered.contains(dep.as_str()))
                    .map(|dep| (*dep).clone())
                    .collect(),
            }
        })
        .collect();

    let edges: Vec<ServiceGraphEdge> = nodes
        .iter()
        .flat_map(|node| {
            node.depends_on.iter().map(|to| ServiceGraphEdge {
                from: node.name.clone(),
                to: to.clone(),
            })
        })
        .collect();

    let (order, cycles) = topo_sort_nodes(&nodes);
    ServiceGraph {
        nodes,
        edges,
        order,
        cycles,
    }
}

/// Kahn's algorithm over the whole node list. Anything left unemitted sits in a
/// cycle, and those are then walked depth-first to recover the paths.
fn topo_sort_nodes(nodes: &[ServiceGraphNode]) -> (Vec<String>, Vec<Vec<String>>) {
    let mut in_degree: HashMap<&str, usize> = nodes.iter().map(|n| (n.name.as_str(), 0)).collect();
    let mut dependents: HashMap<&str, Vec<&str>> = nodes
        .iter()
        .map(|n| (n.name.as_str(), Vec::new()))
        .collect();
    for node in nodes {
        for dep in &node.depends_on {
            // dep must run before node → edge dep -> node.
            *in_degree.get_mut(node.name.as_str()).unwrap() += 1;
            if let Some(list) = dependents.get_mut(dep.as_str()) {
                list.push(node.name.as_str());
            }
        }
    }

    let mut queue: VecDeque<&str> = nodes
        .iter()
        .filter(|n| in_degree[n.name.as_str()] == 0)
        .map(|n| n.name.as_str())
        .collect();
    let mut order: Vec<String> = Vec::with_capacity(nodes.len());
    while let Some(name) = queue.pop_front() {
        order.push(name.to_string());
        for next in dependents[name].clone() {
            let degree = in_degree.get_mut(next).unwrap();
            *degree -= 1;
            if *degree == 0 {
                queue.push_back(next);
            }
        }
    }

    if order.len() == nodes.len() {
        return (order, Vec::new());
    }
    let stuck: HashSet<&str> = nodes
        .iter()
        .map(|n| n.name.as_str())
        .filter(|name| !order.iter().any(|done| done == name))
        .collect();
    (Vec::new(), find_cycles(nodes, &stuck))
}

/// Depth-first walk of the stuck nodes, recording the path each time the walk
/// meets a node already on the stack.
fn find_cycles(nodes: &[ServiceGraphNode], stuck: &HashSet<&str>) -> Vec<Vec<String>> {
    let deps: HashMap<&str, &Vec<String>> = nodes
        .iter()
        .map(|n| (n.name.as_str(), &n.depends_on))
        .collect();
    let mut cycles: Vec<Vec<String>> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut stack: Vec<&str> = Vec::new();
    let mut on_stack: HashSet<&str> = HashSet::new();

    // An explicit frame stack rather than recursion: the node list is config,
    // and a config deep enough to blow the real stack should not be able to.
    for start in nodes.iter().map(|n| n.name.as_str()) {
        if seen.contains(start) || !stuck.contains(start) {
            continue;
        }
        let mut frames: Vec<(&str, usize)> = vec![(start, 0)];
        stack.push(start);
        on_stack.insert(start);
        while let Some((name, index)) = frames.last_mut() {
            let name = *name;
            let list = deps.get(name).copied();
            let next = list.and_then(|l| l.get(*index));
            match next {
                Some(dep) => {
                    *index += 1;
                    let dep = dep.as_str();
                    if !stuck.contains(dep) {
                        continue;
                    }
                    if on_stack.contains(dep) {
                        if let Some(at) = stack.iter().position(|entry| *entry == dep) {
                            cycles.push(stack[at..].iter().map(|s| s.to_string()).collect());
                        }
                    } else if !seen.contains(dep) {
                        frames.push((dep, 0));
                        stack.push(dep);
                        on_stack.insert(dep);
                    }
                }
                None => {
                    frames.pop();
                    stack.pop();
                    on_stack.remove(name);
                    seen.insert(name);
                }
            }
        }
    }
    dedupe_cycles(cycles)
}

/// The same cycle reached from two of its own members is one cycle. Rotations
/// compare equal because the key is the sorted membership.
fn dedupe_cycles(cycles: Vec<Vec<String>>) -> Vec<Vec<String>> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut result = Vec::new();
    for cycle in cycles {
        let mut key: Vec<&String> = cycle.iter().collect();
        key.sort();
        let key = key
            .into_iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("|");
        if seen.insert(key) {
            result.push(cycle);
        }
    }
    result
}

/// Resolve the start order for `requested` services, expanding to include any
/// transitive dependencies that are also registered. Dependencies precede the
/// services that need them. Returns `Err` with a human-readable message when
/// the expanded set contains a cycle. Unknown deps are skipped (they don't
/// block a manual bundle run — they just won't be ordered).
pub fn resolve_start_order(
    services: &[ServiceDef],
    requested: &[String],
) -> Result<Vec<String>, String> {
    let by_name: HashMap<&str, &ServiceDef> =
        services.iter().map(|s| (s.name.as_str(), s)).collect();

    // Depth-first expansion of the requested set plus transitive deps.
    let mut wanted: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = requested.to_vec();
    while let Some(name) = stack.pop() {
        if wanted.contains(&name) {
            continue;
        }
        let Some(def) = by_name.get(name.as_str()) else {
            continue; // not registered → caller surfaces the error on start
        };
        wanted.insert(name.clone());
        if let Some(deps) = &def.depends_on {
            for dep in deps {
                if dep != &name {
                    stack.push(dep.clone());
                }
            }
        }
    }

    topo_sort(services, &wanted)
}

/// Kahn's algorithm over the `wanted` subset, preserving the services' declared
/// order for nodes that are otherwise independent (so the result is stable).
fn topo_sort(services: &[ServiceDef], wanted: &HashSet<String>) -> Result<Vec<String>, String> {
    let registered: HashSet<&str> = services.iter().map(|s| s.name.as_str()).collect();

    // Ordered node list + each node's in-set deps (registered, in-subset, no self, deduped).
    let nodes: Vec<String> = services
        .iter()
        .filter(|s| wanted.contains(&s.name))
        .map(|s| s.name.clone())
        .collect();

    let mut deps: HashMap<String, Vec<String>> = HashMap::new();
    for service in services.iter().filter(|s| wanted.contains(&s.name)) {
        let mut seen = HashSet::new();
        let list: Vec<String> = service
            .depends_on
            .iter()
            .flatten()
            .filter(|dep| {
                *dep != &service.name && registered.contains(dep.as_str()) && wanted.contains(*dep)
            })
            .filter(|dep| seen.insert((*dep).clone()))
            .cloned()
            .collect();
        deps.insert(service.name.clone(), list);
    }

    let mut in_degree: HashMap<&str, usize> = nodes.iter().map(|n| (n.as_str(), 0)).collect();
    let mut dependents: HashMap<&str, Vec<&str>> =
        nodes.iter().map(|n| (n.as_str(), Vec::new())).collect();
    for name in &nodes {
        for dep in &deps[name] {
            *in_degree.get_mut(name.as_str()).unwrap() += 1;
            dependents
                .get_mut(dep.as_str())
                .unwrap()
                .push(name.as_str());
        }
    }

    // Seed the queue in declared order so independent services keep that order.
    let mut queue: VecDeque<&str> = nodes
        .iter()
        .filter(|n| in_degree[n.as_str()] == 0)
        .map(|n| n.as_str())
        .collect();
    let mut order: Vec<String> = Vec::with_capacity(nodes.len());
    while let Some(name) = queue.pop_front() {
        order.push(name.to_string());
        for next in &dependents[name] {
            let degree = in_degree.get_mut(*next).unwrap();
            *degree -= 1;
            if *degree == 0 {
                queue.push_back(next);
            }
        }
    }

    if order.len() == nodes.len() {
        Ok(order)
    } else {
        let stuck: Vec<String> = nodes.into_iter().filter(|n| !order.contains(n)).collect();
        Err(format!(
            "Service dependency cycle detected among: {}.",
            stuck.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(name: &str, deps: &[&str]) -> ServiceDef {
        ServiceDef {
            name: name.to_string(),
            kind: Some("local".to_string()),
            command: Some("true".to_string()),
            args: None,
            cwd: Some("/tmp".to_string()),
            port: None,
            description: None,
            project_path: None,
            env: None,
            test: None,
            depends_on: if deps.is_empty() {
                None
            } else {
                Some(deps.iter().map(|d| d.to_string()).collect())
            },
            compose_file: None,
            compose_service: None,
            host: None,
        }
    }

    #[test]
    fn orders_deps_before_dependents() {
        let services = vec![svc("web", &["api"]), svc("api", &["db"]), svc("db", &[])];
        let order = resolve_start_order(&services, &["web".to_string()]).unwrap();
        assert_eq!(order, vec!["db", "api", "web"]);
    }

    #[test]
    fn skips_unknown_deps() {
        let services = vec![svc("web", &["ghost"])];
        let order = resolve_start_order(&services, &["web".to_string()]).unwrap();
        assert_eq!(order, vec!["web"]);
    }

    #[test]
    fn reports_a_cycle() {
        let services = vec![svc("a", &["b"]), svc("b", &["a"])];
        let result = resolve_start_order(&services, &["a".to_string()]);
        assert!(result.is_err());
    }
}
