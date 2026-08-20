//! Service dependency ordering (mirrors `src/core/service-graph.ts`).
//!
//! Services declare `dependsOn`; this turns those declarations into a
//! topological start order so dependencies come up before dependents. Used by
//! the `start_bundle` / `stop_bundle` commands. Unknown deps and self-refs are
//! ignored; a cycle is reported as an `Err` so the caller can refuse to start.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::config::ServiceDef;

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
