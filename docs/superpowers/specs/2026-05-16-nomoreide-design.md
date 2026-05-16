# NoMoreIDE MCP Design

## Goal

NoMoreIDE MCP is a local developer service manager exposed through MCP. It lets AI coding agents and humans start, stop, restart, inspect, and group explicitly registered development services such as frontends, backends, databases, and workers.

## Product Scope

The first version manages only services registered by the user or by an MCP client. It does not scan or control arbitrary machine processes. This keeps behavior predictable and avoids surprising users by killing or modifying processes outside NoMoreIDE ownership.

## Core Concepts

- Service: A named command with a working directory, optional port, optional environment variables, and optional description.
- Bundle: A named group of services that can be started, stopped, or restarted together.
- Run session: One in-memory process started by NoMoreIDE, with status, PID, start time, exit data, and logs.

## Architecture

The project is a Node.js TypeScript application using the TypeScript `fastmcp` package for MCP exposure. A shared core module owns config persistence, process lifecycle, and log storage. The MCP server, TUI, and future web UI call the same core APIs.

The MVP ships the MCP server and core manager first. The TUI and web UI are represented by documented commands and file boundaries, then can be layered on the same core without changing process behavior.

## Storage

Service and bundle definitions are persisted in a JSON file. By default the file is `nomoreide.config.json` in the current working directory where NoMoreIDE is launched. Logs are written under `.nomoreide/logs/` and also kept in bounded memory for fast MCP reads.

## MCP Tools

- `nomoreide_list_services`
- `nomoreide_register_service`
- `nomoreide_start_service`
- `nomoreide_stop_service`
- `nomoreide_restart_service`
- `nomoreide_read_logs`
- `nomoreide_register_bundle`
- `nomoreide_start_bundle`
- `nomoreide_stop_bundle`
- `nomoreide_status`

## Process Behavior

Starting a service spawns the configured command with shell execution in the configured working directory. NoMoreIDE tracks the child process it starts, captures stdout and stderr, and records exit code or signal. If NoMoreIDE restarts, saved service definitions remain, but previously spawned processes are not treated as managed.

Stopping a service sends `SIGTERM` first. If the process has not exited after a short timeout, NoMoreIDE sends `SIGKILL`.

## Port Behavior

If a service has a configured port, NoMoreIDE checks whether the port is already listening before start. A busy port is reported as a conflict instead of automatically killing an unrelated process.

## Interfaces

The first usable interface is MCP. A minimal CLI starts the MCP server. TUI and web UI are later interfaces over the same service manager, not separate implementations.

## Verification

The MVP is verified with unit tests for config persistence, process lifecycle, log capture, bundle operations, and port checks. A build command verifies TypeScript compilation.
