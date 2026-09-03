#!/usr/bin/env python3
"""Seeded regression sweep for scripts/check-service-config-parity.ts.

Each seed makes one behavioural change to the Rust source, rebuilds, and expects
the gate to fail on a *named* case. A seed the gate does not catch is a hole in
the gate, not a success.

Two clusters of seeds here are about things the gate would otherwise take on
trust. The first is the **error envelope**: the reference catches a port
conflict and nothing else, so every other refusal is a 500 with prose. Seeds put
the semantic statuses back, and put the error code back on the wire, because
both of those looked more correct than what the reference actually does and both
were shipping.

The second is the **shadowing of `/api/services/graph`**. It is a single path
segment, so it is covered by the `/api/services/:name` pattern route in the
reference, and a wrong method there is a 405 while a DELETE is a real delete.
Seeds break each half of that separately.

Run it alone: it mutates tracked sources and restores them from an in-memory
backup, so a second cargo build racing it tests a binary that is one edit behind
its source. Killing it mid-run leaves a seed on disk.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROUTE = "crates/nomoreide-daemon/src/server/routes/service_config.rs"
ERRORS = "crates/nomoreide-daemon/src/server/errors.rs"
GRAPH = "crates/nomoreide-core/src/service_graph.rs"
CONFIG = "crates/nomoreide-core/src/config.rs"
RUNTIME = "crates/nomoreide-daemon/src/runtime.rs"
ROUTE_ERRORS = "crates/nomoreide-daemon/src/server/routes/service_config.rs"
SERVICES = "crates/nomoreide-daemon/src/server/routes/services.rs"
MANAGER = "crates/nomoreide-core/src/process_manager.rs"
PROTOCOL = "crates/nomoreide-daemon-client/src/protocol.rs"
BUNDLES = "crates/nomoreide-daemon/src/runtime/bundles.rs"

SEEDS = [
    # --- the error envelope ---------------------------------------------------
    ("a-refusal-keeps-its-semantic-status", ERRORS,
     r"""    error(StatusCode::INTERNAL_SERVER_ERROR, &message)""",
     r"""    error(StatusCode::NOT_FOUND, &message)""",
     "bundle-restart/unknown"),
    ("a-refusal-carries-a-code", ERRORS,
     r"""            Json(MutationErrorEnvelope {
                ok: false,
                error: message,
                conflict: Some(*conflict),
            }),""",
     r"""            Json(serde_json::json!({
                "ok": false,
                "error": message,
                "code": "PORT_IN_USE",
                "conflict": *conflict,
            })),""",
     "service-start/port-in-use"),

    # --- the shadowed graph path ----------------------------------------------
    ("a-wrong-method-on-graph-falls-to-the-shell", ROUTE,
     r"""        .route("/api/services/graph", get(graph).fallback(shadowed_graph))""",
     r"""        .route("/api/services/graph", get(graph))""",
     "graph/wrong-method"),
    ("deleting-a-shadowed-path-is-a-refusal", ROUTE,
     r"""    if method == Method::DELETE {
        return remove_service(state, Path(name.to_string())).await;
    }
    method_not_allowed().await""",
     r"""    let _ = (state, name);
    method_not_allowed().await""",
     "graph/delete"),

    # --- the graph itself -----------------------------------------------------
    ("an-unknown-dependency-is-dropped-rather-than-reported", GRAPH,
     r"""                missing: declared
                    .iter()
                    .filter(|dep| !registered.contains(dep.as_str()))
                    .map(|dep| (*dep).clone())
                    .collect(),""",
     r"""                missing: Vec::new(),""",
     "graph/read"),
    ("a-self-reference-is-an-edge", GRAPH,
     r"""                .filter(|dep| **dep != service.name)""",
     r"""                .filter(|_dep| true)""",
     "graph/read"),
    ("a-duplicate-dependency-is-two-edges", GRAPH,
     r"""                .filter(|dep| seen.insert((*dep).clone()))""",
     r"""                .filter(|dep| {
                    seen.insert((*dep).clone());
                    true
                })""",
     "graph/read"),
    ("a-cycle-still-produces-an-order", GRAPH,
     r"""    (Vec::new(), find_cycles(nodes, &stuck))""",
     r"""    (order, find_cycles(nodes, &stuck))""",
     "graph/read"),
    ("a-cycle-is-reported-as-a-set-rather-than-a-path", GRAPH,
     r"""                            cycles.push(stack[at..].iter().map(|s| s.to_string()).collect());""",
     r"""                            let mut path: Vec<String> =
                                stack[at..].iter().map(|s| s.to_string()).collect();
                            path.reverse();
                            cycles.push(path);""",
     "graph/read"),

    # --- definition -----------------------------------------------------------
    ("a-definition-is-cacheable", ROUTE,
     r"""    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));""",
     r"""    let _ = &mut response;""",
     "definition/known"),
    ("a-definition-is-the-redacted-view", ROUTE,
     r"""    let mut response = Json(json!({ "ok": true, "service": service })).into_response();""",
     r"""    let redacted = serde_json::to_value(config.public_view())
        .ok()
        .and_then(|value| value.get("services").cloned())
        .and_then(|services| {
            services
                .as_array()
                .and_then(|list| list.iter().find(|entry| entry["name"] == name.as_str()).cloned())
        })
        .unwrap_or(serde_json::Value::Null);
    let mut response = Json(json!({ "ok": true, "service": redacted })).into_response();""",
     "definition/with-every-field"),
    ("a-definition-trims-the-name-it-looks-up", ROUTE,
     r"""    let Some(service) = config.services.iter().find(|s| s.name == name) else {""",
     r"""    let Some(service) = config.services.iter().find(|s| s.name == name.trim()) else {""",
     "definition/a-padded-name"),

    # --- project --------------------------------------------------------------
    ("a-blank-project-path-is-stored", CONFIG,
     r"""        let assigned = project_path
            .map(str::trim)
            .filter(|value| !value.is_empty());""",
     r"""        let assigned = project_path.map(str::trim);""",
     "project/clear-with-blank"),
    ("a-project-refusal-is-a-400", ROUTE,
     r"""        Err(reason) => error(StatusCode::NOT_FOUND, &reason.to_string()),
    }
}

/// Register a bundle, or rename one.""",
     r"""        Err(reason) => error(StatusCode::BAD_REQUEST, &reason.to_string()),
    }
}

/// Register a bundle, or rename one.""",
     "project/unknown-service"),

    # --- bundles --------------------------------------------------------------
    ("a-missing-bundle-name-is-a-400", ROUTE,
     r"""        return error(StatusCode::INTERNAL_SERVER_ERROR, "name is required");""",
     r"""        return error(StatusCode::BAD_REQUEST, "name is required");""",
     "bundles/missing-name"),
    ("a-rename-leaves-the-old-name-behind", CONFIG,
     r"""            .retain(|b| b.name != bundle.name && Some(b.name.as_str()) != previous_name);""",
     r"""            .retain(|b| b.name != bundle.name);""",
     "bundles/rename"),
    ("a-blank-member-is-kept", ROUTE,
     r"""        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();""",
     r"""        .map(str::to_string)
        .collect();""",
     "bundles/blank-members-are-dropped"),

    # --- delete ---------------------------------------------------------------
    ("deleting-an-unknown-service-succeeds", CONFIG,
     r"""        if config.services.len() == before {
            bail!("Service \"{name}\" is not registered.");
        }""",
     r"""        let _ = before;""",
     "delete/unknown"),
    ("a-delete-leaves-the-bundles-alone", CONFIG,
     r"""        config
            .bundles
            .iter_mut()
            .for_each(|b| b.services.retain(|s| s != name));""",
     "",
     "delete/a-bundle-member"),
    ("a-delete-does-not-decode-its-name", ROUTE,
     r"""        .route(
            "/api/services/:name",
            delete(remove_service).fallback(method_not_allowed),
        )""",
     r"""        .route(
            "/api/services/{name}",
            delete(remove_service).fallback(method_not_allowed),
        )""",
     "delete/an-encoded-name"),

    # --- stop, which no longer consults config --------------------------------
    ("stopping-an-unknown-service-is-refused", RUNTIME,
     r"""        if self.process_manager.service_status(name).is_none() {
            self.registered_startable_service(name).await?;
        }
        self.process_manager""",
     r"""        self.process_manager""",
     "service-stop/unknown"),

    # --- restart --------------------------------------------------------------
    ("a-restart-starts-before-it-stops", BUNDLES,
     r"""        self.stop_bundle(name).await?;
        self.start_bundle(name).await""",
     r"""        let started = self.start_bundle(name).await;
        self.stop_bundle(name).await?;
        started""",
     "bundle-restart/the-state-afterwards"),

    # --- what a conflict looks like, and where -------------------------------
    # All three of these were shipping until a case reached the 409 branch at
    # all: no gate had ever held a port.
    ("a-bundle-conflict-is-a-409", ROUTE_ERRORS,
     r"""        Err(reason) => crate::server::errors::mutation_error(reason),""",
     r"""        Err(reason) => crate::server::errors::service_mutation_error(reason),""",
     "bundle-restart/a-member-port-is-held"),
    ("a-service-conflict-is-a-plain-500", SERVICES,
     r"""        Err(error) => service_mutation_error(error),""",
     r"""        Err(error) => crate::server::errors::mutation_error(error),""",
     "service-start/port-in-use"),
    ("a-conflict-message-has-no-full-stop", MANAGER,
     r"""                "Port {} is already in use for {} (held by pid {} — {}).",""",
     r"""                "Port {} is already in use for {} (held by pid {} — {})",""",
     "service-start/port-in-use"),
    # Two edits each: the field, and the place it is constructed. One without
    # the other does not compile, which is not the same as not biting.
    ("a-holder-carries-its-start-token", [
        (PROTOCOL,
         r"""pub struct PortHolderIdentity {
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgid: Option<u32>,
    pub command: String,
}""",
         r"""pub struct PortHolderIdentity {
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgid: Option<u32>,
    pub command: String,
    pub start_token: String,
}"""),
        (RUNTIME,
         r"""        pgid: holder.pgid,
        command: holder.command.clone(),""",
         r"""        pgid: holder.pgid,
        command: holder.command.clone(),
        start_token: holder.start_token.clone(),"""),
     ], "service-start/port-in-use"),
    ("a-status-carries-a-pgid", [
        (PROTOCOL,
         r"""    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    // No `pgid`.""",
         r"""    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgid: Option<u32>,
    // No `pgid`."""),
        (RUNTIME,
         r"""        pid: status.pid,
        exit_code: status.exit_code,""",
         r"""        pid: status.pid,
        pgid: status.pgid,
        exit_code: status.exit_code,"""),
        (RUNTIME,
         r"""        pid: None,
        exit_code: None,""",
         r"""        pid: None,
        pgid: None,
        exit_code: None,"""),
     ], "bundle-restart/the-state-afterwards"),
]

def read(path):
    with open(os.path.join(ROOT, path)) as handle:
        return handle.read()


def write(path, text):
    with open(os.path.join(ROOT, path), "w") as handle:
        handle.write(text)


def cargo_is_busy():
    probe = subprocess.run(["cargo", "build", "-p", "nomoreide-cli", "--quiet"], cwd=ROOT,
                           capture_output=True, text=True, timeout=1800)
    return "Blocking waiting for file lock" in probe.stderr


def edits_of(seed):
    """Normalise a seed to (name, [(path, old, new)], expected).

    Adding a field back to a struct is two edits in two files — the field and
    the place it is constructed — and a seed that makes only the first does not
    compile, which the sweep reports as SEED-DID-NOT-COMPILE rather than as a
    hole. So a seed may be either the plain 5-tuple or (name, edits, expected).
    """
    if len(seed) == 3:
        name, edits, expected = seed
        return name, list(edits), expected
    name, path, old, new, expected = seed
    return name, [(path, old, new)], expected


def main():
    wanted = set(sys.argv[1:])
    seeds = [edits_of(s) for s in SEEDS if not wanted or s[0] in wanted]
    unknown = wanted - {s[0] for s in SEEDS}
    if unknown:
        print("no such seed: " + ", ".join(sorted(unknown)))
        return 2
    backups = {path: read(path)
               for _name, edits, _expected in seeds
               for path, _old, _new in edits}

    stale = [
        (name, backups[path].count(old))
        for name, edits, _expected in seeds
        for path, old, _new in edits
        if backups[path].count(old) != 1
    ]
    if stale:
        for name, count in stale:
            print(f"SEED-ANCHOR-STALE  {name}  (matches: {count})")
        print("\nFix the anchors before sweeping; nothing was changed.")
        return 2

    if cargo_is_busy():
        print("Another cargo build holds the target lock; a seeded sweep that races one")
        print("tests a binary that is one edit behind its source.")
        return 2

    results = []
    try:
        for name, edits, expected in seeds:
            # Accumulate per file: two edits to the same file must compose,
            # not each start from the pristine backup and discard the other.
            seeded = {}
            for path, old, new in edits:
                seeded[path] = seeded.get(path, backups[path]).replace(old, new, 1)
            for path, text in seeded.items():
                write(path, text)
            restore = lambda: [write(path, backups[path]) for path, _o, _n in edits]
            build = subprocess.run(["cargo", "build", "-p", "nomoreide-cli"], cwd=ROOT, capture_output=True, text=True)
            if build.returncode != 0:
                results.append((name, "SEED-DID-NOT-COMPILE", build.stderr[-300:]))
                restore()
                print(f"{'SEED-DID-NOT-COMPILE':24} {name}", flush=True)
                continue
            gate = subprocess.run(
                ["node", "--import", "tsx",
                 "scripts/check-service-config-parity.ts", "./target/debug/nomoreide"],
                cwd=ROOT, capture_output=True, text=True)
            names = {line.split()[1] for line in gate.stdout.splitlines()
                     if line.startswith("FAIL ") and len(line.split()) > 1}
            if gate.returncode == 0:
                results.append((name, "GATE-DID-NOT-BITE", expected))
            elif expected in names:
                results.append((name, "caught", f"{len(names)} case(s), incl. {expected}"))
            else:
                results.append((name, "CAUGHT-WRONG-CASE", f"expected {expected}, got {sorted(names)[:3]}"))
            print(f"{results[-1][1]:24} {name}", flush=True)
            restore()
    finally:
        for path, source in backups.items():
            write(path, source)
        subprocess.run(["cargo", "build", "-p", "nomoreide-cli"], cwd=ROOT, capture_output=True, text=True)

    print("\n=== sweep ===")
    for name, verdict, detail in results:
        print(f"{verdict:24} {name}  ({detail})")
    caught = sum(1 for _, verdict, _ in results if verdict == "caught")
    print(f"\ncaught {caught}/{len(results)}")
    return 0 if caught == len(results) else 1


# **Guarded on purpose.** Importing this file to reuse SEEDS -- to validate the
# anchors, say -- must not start a sweep.
if __name__ == "__main__":
    sys.exit(main())
