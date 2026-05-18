# NoMoreIDE MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js TypeScript FastMCP server that manages explicitly registered local dev services and bundles.

**Architecture:** A shared core owns config persistence, log storage, port checks, and child process lifecycle. The FastMCP layer exposes those capabilities as MCP tools. The CLI starts the MCP stdio server.

**Tech Stack:** Node.js, TypeScript, FastMCP, Zod, Vitest, npm.

---

## File Structure

- `package.json`: npm scripts, runtime dependencies, dev dependencies, bin entry.
- `tsconfig.json`: TypeScript compiler settings for Node ESM.
- `src/index.ts`: CLI entry that starts the MCP server.
- `src/core/types.ts`: Shared service, bundle, runtime, and result types.
- `src/core/config-store.ts`: JSON config loading, validation, and saving.
- `src/core/log-store.ts`: In-memory and file-backed log capture.
- `src/core/port-utils.ts`: Registered port availability checks.
- `src/core/process-manager.ts`: Service and bundle lifecycle.
- `src/mcp/server.ts`: FastMCP server and tool registration.
- `src/tui/app.ts`: Placeholder module documenting the TUI boundary.
- `src/web/server.ts`: Placeholder module documenting the web UI boundary.
- `test/*.test.ts`: Focused tests for core behavior.
- `README.md`: Usage, MCP setup, and example service definitions.

## Tasks

### Task 1: Scaffold TypeScript Package

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`

- [ ] Create package metadata with scripts for `build`, `test`, and `dev`.
- [ ] Configure TypeScript for Node ESM output in `dist`.
- [ ] Add a temporary CLI entry that prints startup intent.
- [ ] Run `npm install`.
- [ ] Run `npm run build`.

### Task 2: Add Core Types and Config Store

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/config-store.ts`
- Create: `test/config-store.test.ts`

- [ ] Define service and bundle types.
- [ ] Write tests for default config creation, registering a service, and registering a bundle.
- [ ] Implement JSON config load/save with Zod validation.
- [ ] Run `npm test -- config-store`.

### Task 3: Add Log Store and Port Utilities

**Files:**
- Create: `src/core/log-store.ts`
- Create: `src/core/port-utils.ts`
- Create: `test/log-store.test.ts`
- Create: `test/port-utils.test.ts`

- [ ] Write tests for bounded in-memory logs and file log persistence.
- [ ] Write tests for free and occupied port detection.
- [ ] Implement log storage.
- [ ] Implement TCP port checks.
- [ ] Run `npm test -- log-store port-utils`.

### Task 4: Add Process Manager

**Files:**
- Create: `src/core/process-manager.ts`
- Create: `test/process-manager.test.ts`

- [ ] Write tests for service start, log capture, stop, restart, and bundle start.
- [ ] Implement child process lifecycle.
- [ ] Implement graceful stop with kill fallback.
- [ ] Implement bundle operations through service operations.
- [ ] Run `npm test -- process-manager`.

### Task 5: Add FastMCP Server

**Files:**
- Create: `src/mcp/server.ts`
- Modify: `src/index.ts`
- Create: `test/mcp-server.test.ts`

- [ ] Write tests that the server factory can be created with all expected tool names.
- [ ] Implement FastMCP tool registration for services, bundles, logs, and status.
- [ ] Update CLI entry to start the MCP server over stdio.
- [ ] Run `npm test -- mcp-server`.

### Task 6: Add Interface Boundaries and Docs

**Files:**
- Create: `src/tui/app.ts`
- Create: `src/web/server.ts`
- Create: `README.md`

- [ ] Add placeholder exports for future TUI and web UI modules.
- [ ] Document the MVP scope, commands, MCP setup, service config, and bundle examples.
- [ ] Run `npm run build`.
- [ ] Run `npm test`.
