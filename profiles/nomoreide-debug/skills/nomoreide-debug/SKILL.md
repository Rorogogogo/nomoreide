---
name: nomoreide-debug
description: Debug and troubleshoot local development services through the shared NoMoreIDE MCP daemon. Use this skill whenever the user asks to debug, diagnose, troubleshoot, run or start an app or service, inspect a crash, investigate logs, fix an unhealthy server, resolve a port conflict, restart a service, or determine why a frontend or backend is not loading—even when they do not mention NoMoreIDE.
compatibility: Requires the nomoreide MCP server and a registered NoMoreIDE service, bundle, or repository.
---

# Debug with NoMoreIDE

Use NoMoreIDE as the shared runtime control plane so the human, agent, dashboard,
CLI, and other sessions observe the same processes and logs.

## Workflow

1. Call `nomoreide_list_services` and `nomoreide_status`.
2. Match the current repository and the user's wording to a registered service
   or bundle. Ask for the intended target only when multiple matches remain.
3. Before changing runtime state, inspect `nomoreide_service_health`,
   `nomoreide_service_context`, `nomoreide_read_logs`, and
   `nomoreide_timeline` as relevant.
4. When the user wants the application running, start the registered target
   with `nomoreide_start_service` or `nomoreide_start_bundle`. Do not launch
   its command in a separate shell because that creates a duplicate process
   outside the shared runtime.
5. Diagnose the evidence, inspect the affected code, and make only the changes
   the user authorized.
6. Restart through NoMoreIDE when the fix requires it, then re-check health,
   logs, and timeline to verify the result.

If the project is not registered, explain that clearly and use the NoMoreIDE
onboarding or registration flow before managing it. If the MCP is unavailable,
report that setup is missing instead of silently falling back to an unmanaged
development process.

Starting, stopping, or restarting changes shared machine state. A request to
debug or diagnose authorizes inspection, not a runtime mutation. Start only
when the user explicitly asks to run or start the target. Before stopping or
restarting, explain why it is needed and get permission unless the user
explicitly requested that exact action.
