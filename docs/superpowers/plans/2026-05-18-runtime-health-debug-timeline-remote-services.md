# Runtime Health, Debug Timeline, and Remote Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build NoMoreIDE into a runtime workbench that helps humans and agents understand service health, debug history, and local or remote service execution without needing a full IDE.

**Architecture:** Extend the existing service manager around four explicit capabilities: service health snapshots, append-only debug timeline events, Docker Compose-backed services, and SSH-backed services. Keep NoMoreIDE as the runtime cockpit rather than an agent job system: it observes, summarizes, and exposes context to any MCP client while leaving the coding agent in its own workspace.

**Tech Stack:** Node.js, TypeScript, FastMCP, React, Vite, Vitest, native `child_process`, local HTTP dashboard, existing NoMoreIDE config and log store.

---

## Product Direction

NoMoreIDE should not become another AI coding workspace. The core product promise is:

> NoMoreIDE frees developers from IDE tabs by centralizing services, logs, ports, health, Git, and debug context for humans and AI agents.

The next features should make NoMoreIDE excellent at answering these questions:

- What is running?
- Is it healthy?
- Why is it unhealthy?
- What changed recently?
- What exact context should I give my agent?
- Can I run the same service locally, in Docker, or over SSH from one control surface?

## Scope

This plan covers four implementation phases:

1. **Service Health + Agent Context**
2. **AI Debug Timeline**
3. **Docker Compose Services**
4. **SSH Remote Services**

The phases are ordered deliberately. Service health and timeline are foundational and should be implemented before Docker and SSH. Docker should ship before SSH because Docker has clearer process ownership and fewer credential/security concerns.

## File Structure

### Existing Files To Modify

- `src/core/types.ts`
  - Extend service definitions, runtime status, and dashboard DTO types.
- `src/core/config-store.ts`
  - Validate new service kinds and health-check fields.
- `src/core/process-manager.ts`
  - Emit lifecycle events and expose process-tree-aware status.
- `src/core/port-utils.ts`
  - Fix port detection across `127.0.0.1`, `localhost`, `::1`, and `0.0.0.0`.
- `src/core/log-store.ts`
  - Emit log events into the timeline.
- `src/web/dashboard.ts`
  - Include health summaries, debug timeline, and agent context in `/api/dashboard`.
- `src/web/client/src/lib/api.ts`
  - Add client types for health, timeline, Docker, SSH, and agent-context payloads.
- `src/web/client/src/features/services/services-view.tsx`
  - Surface service health, resource usage, debug context, and remote service kind.
- `src/web/client/src/features/services/service-actions.tsx`
  - Add copy context, health check, and service-kind-aware actions.
- `src/mcp/tools.ts`
  - Add MCP tools for health snapshots, timeline reads, and context packets.
- `src/cli/commands.ts`
  - Add CLI commands for health and timeline inspection.
- `README.md`
  - Document health, timeline, Docker, and SSH service configuration.

### New Files To Create

- `src/core/service-health.ts`
  - Computes health status from runtime, process tree, ports, logs, and configured checks.
- `src/core/process-tree.ts`
  - Reads process descendants and resource usage for a service root PID.
- `src/core/timeline-store.ts`
  - Stores bounded append-only timeline events in memory and on disk.
- `src/core/agent-context.ts`
  - Builds copyable context packets for humans and MCP clients.
- `src/core/docker-service-runner.ts`
  - Starts, stops, inspects, and logs Docker Compose services.
- `src/core/ssh-service-runner.ts`
  - Starts, stops, and inspects remote commands through the user's existing SSH config.
- `src/web/client/src/features/services/health-summary.tsx`
  - Compact health UI for each service.
- `src/web/client/src/features/services/debug-timeline.tsx`
  - Timeline UI for lifecycle, logs, ports, health, and agent/MCP events.
- `src/web/client/src/features/services/agent-context-panel.tsx`
  - UI for copyable agent context and suggested prompts.
- `test/service-health.test.ts`
  - Health computation tests.
- `test/process-tree.test.ts`
  - Process tree parsing and aggregation tests.
- `test/timeline-store.test.ts`
  - Timeline persistence and bounding tests.
- `test/agent-context.test.ts`
  - Context packet generation tests.
- `test/docker-service-runner.test.ts`
  - Docker runner command construction tests using mocked process execution.
- `test/ssh-service-runner.test.ts`
  - SSH runner command construction and safety tests using mocked process execution.
- `test/port-utils.test.ts`
  - Extend existing port tests for IPv4/IPv6/wildcard detection.

---

## Target User Experience

### Service Health Card

Each service card should show:

- state: `running`, `stopped`, `exited`, `unhealthy`
- kind: `local`, `docker-compose`, `ssh`
- PID and child process count when local
- CPU and RSS memory when measurable
- configured port and actual bound addresses
- health-check result and latency
- last log error
- restart count
- copyable agent context

Example card text:

```text
jobjourney-frontend
running · local · :5001 · 3 processes
Memory high: 1.2 GB RSS
Port bound on 0.0.0.0, not 127.0.0.1
Last error: none
Health: GET / returned 200 in 10 ms
```

### Agent Context Packet

The context packet should be useful for Claude, Codex, Gemini, or any MCP client.

Example:

```text
Investigate NoMoreIDE service "jobjourney-frontend".

Service:
- kind: local
- command: npm run dev
- cwd: /Users/roro/Downloads/work/JJ/JobJourney/Client
- configured port: 5001
- runtime url: http://localhost:5001/
- state: running
- process tree RSS: 1.2 GB
- CPU: idle

Recent timeline:
- service started at 2026-05-18T12:34:28.766Z
- Vite reported http://localhost:5001/
- health check GET / returned 200 in 10 ms

Recent errors:
- none

Please explain why this dev server may be memory-heavy and propose safe improvements.
```

### Debug Timeline

The timeline should show events from humans, NoMoreIDE, service processes, and MCP tools:

```text
12:31:28 service nomoreide-website started
12:31:29 port 5174 bound on 127.0.0.1
12:34:27 service brainctl-platform-frontend started
12:34:28 log brainctl-platform-frontend: VITE ready in 158 ms
12:35:10 health jobjourney-backend: GET / returned 200 in 2 ms
12:36:02 mcp nomoreide_read_logs called for jobjourney-backend
```

---

## Data Model

### Service Kind

Modify `src/core/types.ts`:

```ts
export type ServiceKind = "local" | "docker-compose" | "ssh";

export interface BaseServiceDefinition {
  name: string;
  kind?: ServiceKind;
  port?: number;
  description?: string;
  healthCheck?: HealthCheckDefinition;
}

export interface LocalServiceDefinition extends BaseServiceDefinition {
  kind?: "local";
  command: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface DockerComposeServiceDefinition extends BaseServiceDefinition {
  kind: "docker-compose";
  cwd: string;
  composeFile?: string;
  composeService: string;
}

export interface SshServiceDefinition extends BaseServiceDefinition {
  kind: "ssh";
  host: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
}

export type ServiceDefinition =
  | LocalServiceDefinition
  | DockerComposeServiceDefinition
  | SshServiceDefinition;
```

### Health Check

```ts
export interface HealthCheckDefinition {
  url?: string;
  path?: string;
  timeoutMs?: number;
  expectedStatus?: number;
}

export interface ServiceHealth {
  service: string;
  status: "unknown" | "healthy" | "warning" | "unhealthy";
  summary: string;
  checkedAt: string;
  checks: HealthCheckResult[];
  processTree?: ProcessTreeSummary;
  ports: PortBindingStatus[];
  lastErrorLog?: LogEntry;
  agentContext: string;
}
```

### Timeline Event

```ts
export type TimelineEventKind =
  | "service.lifecycle"
  | "service.log"
  | "service.health"
  | "service.port"
  | "mcp.tool"
  | "git.change"
  | "user.action";

export interface TimelineEvent {
  id: string;
  timestamp: string;
  kind: TimelineEventKind;
  service?: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}
```

---

## Implementation Tasks

### Task 1: Fix Port Detection Across Hosts

**Files:**
- Modify: `src/core/port-utils.ts`
- Modify: `src/web/dashboard.ts`
- Test: `test/port-utils.test.ts`

- [x] **Step 1: Add failing tests for IPv4, IPv6, and wildcard listeners**

Add tests that prove a port is considered busy if any common bind address is busy:

```ts
import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { getPortBindingStatus } from "../src/core/port-utils.js";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.length = 0;
});

async function listen(host: string): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

describe("getPortBindingStatus", () => {
  test("detects a port bound on 127.0.0.1", async () => {
    const port = await listen("127.0.0.1");
    await expect(getPortBindingStatus(port)).resolves.toMatchObject({
      port,
      available: false,
    });
  });

  test("detects a port bound on localhost or IPv6", async () => {
    const port = await listen("::1");
    const status = await getPortBindingStatus(port);
    expect(status.available).toBe(false);
    expect(status.hosts.some((host) => host.host === "::1" && !host.available))
      .toBe(true);
  });
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/port-utils.test.ts`

Expected: FAIL because `getPortBindingStatus` does not exist.

- [x] **Step 3: Implement multi-host port status**

Add:

```ts
export interface HostPortStatus {
  host: string;
  available: boolean;
  errorCode?: string;
}

export interface PortBindingStatus {
  port: number;
  available: boolean;
  hosts: HostPortStatus[];
}

export async function getPortBindingStatus(port: number): Promise<PortBindingStatus> {
  const hosts = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
  const statuses = await Promise.all(
    hosts.map(async (host) => ({
      host,
      ...(await checkHostPort(port, host)),
    })),
  );

  return {
    port,
    available: statuses.every((status) => status.available),
    hosts: statuses,
  };
}

async function checkHostPort(
  port: number,
  host: string,
): Promise<{ available: boolean; errorCode?: string }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve({ available: false, errorCode: error.code });
        return;
      }
      reject(error);
    });

    server.listen(port, host, () => {
      server.close(() => resolve({ available: true }));
    });
  });
}
```

- [x] **Step 4: Update dashboard port overview**

Use `getPortBindingStatus(port)` in `src/web/dashboard.ts` and include host details in the payload.

- [x] **Step 5: Run tests**

Run: `npx vitest run test/port-utils.test.ts test/web-server.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/core/port-utils.ts src/web/dashboard.ts test/port-utils.test.ts
git commit -m "fix: detect service ports across bind hosts"
```

### Task 2: Add Process Tree Resource Snapshots

**Files:**
- Create: `src/core/process-tree.ts`
- Modify: `src/core/process-manager.ts`
- Test: `test/process-tree.test.ts`

- [x] **Step 1: Write tests for parsing `ps` output**

```ts
import { describe, expect, test } from "vitest";
import { parseProcessRows, summarizeProcessTree } from "../src/core/process-tree.js";

describe("process tree", () => {
  test("summarizes descendants by CPU and RSS", () => {
    const rows = parseProcessRows(`
      10 1 0.0 100 npm run dev
      11 10 1.5 200 node vite
      12 11 0.2 50 esbuild
      99 1 8.0 999 unrelated
    `);

    const summary = summarizeProcessTree(rows, 10);

    expect(summary).toMatchObject({
      rootPid: 10,
      processCount: 3,
      cpuPercent: 1.7,
      rssMb: 350,
    });
    expect(summary.processes.map((process) => process.pid)).toEqual([10, 11, 12]);
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/process-tree.test.ts`

Expected: FAIL because `src/core/process-tree.ts` does not exist.

- [x] **Step 3: Implement process tree parser and reader**

Create `src/core/process-tree.ts` with:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  cpuPercent: number;
  rssMb: number;
  command: string;
}

export interface ProcessTreeSummary {
  rootPid: number;
  processCount: number;
  cpuPercent: number;
  rssMb: number;
  processes: ProcessRow[];
}

export function parseProcessRows(raw: string): ProcessRow[] {
  return raw
    .trim()
    .split(/\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match) return undefined;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpuPercent: Number(match[3]),
        rssMb: Number(match[4]) / 1024,
        command: match[5],
      };
    })
    .filter((row): row is ProcessRow => Boolean(row));
}

export function summarizeProcessTree(
  rows: ProcessRow[],
  rootPid: number,
): ProcessTreeSummary {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid) ?? [];
    siblings.push(row);
    byParent.set(row.ppid, siblings);
  }

  const root = rows.find((row) => row.pid === rootPid);
  const processes: ProcessRow[] = root ? [root] : [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) continue;
    for (const child of byParent.get(pid) ?? []) {
      processes.push(child);
      stack.push(child.pid);
    }
  }

  return {
    rootPid,
    processCount: processes.length,
    cpuPercent: roundOne(processes.reduce((sum, row) => sum + row.cpuPercent, 0)),
    rssMb: roundOne(processes.reduce((sum, row) => sum + row.rssMb, 0)),
    processes,
  };
}

export async function readProcessTree(rootPid: number): Promise<ProcessTreeSummary> {
  const { stdout } = await execFileAsync("ps", [
    "-ax",
    "-o",
    "pid=,ppid=,%cpu=,rss=,command=",
  ]);
  return summarizeProcessTree(parseProcessRows(stdout), rootPid);
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
```

- [x] **Step 4: Expose resource summary in service status**

In `src/core/process-manager.ts`, add an async method:

```ts
async statusWithResources(): Promise<NoMoreIdeStatus> {
  const services: Record<string, ServiceStatus> = {};
  for (const [name, runtime] of this.runtimes.entries()) {
    services[name] = { ...runtime.status };
    if (runtime.status.pid && runtime.status.state === "running") {
      services[name].processTree = await readProcessTree(runtime.status.pid);
    }
  }
  return { services };
}
```

Add `processTree?: ProcessTreeSummary` to `ServiceStatus` in `src/core/types.ts`.

- [x] **Step 5: Run tests**

Run: `npx vitest run test/process-tree.test.ts test/process-manager.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/core/process-tree.ts src/core/process-manager.ts src/core/types.ts test/process-tree.test.ts
git commit -m "feat: summarize service process trees"
```

### Task 3: Add Service Health Computation

**Files:**
- Create: `src/core/service-health.ts`
- Modify: `src/web/dashboard.ts`
- Modify: `src/core/types.ts`
- Test: `test/service-health.test.ts`

- [x] **Step 1: Write health summary tests**

```ts
import { describe, expect, test } from "vitest";
import { computeServiceHealth } from "../src/core/service-health.js";

describe("computeServiceHealth", () => {
  test("marks high memory services as warning", () => {
    const health = computeServiceHealth({
      service: { name: "frontend", command: "npm run dev", cwd: "/app", port: 5001 },
      status: {
        name: "frontend",
        state: "running",
        processTree: {
          rootPid: 10,
          processCount: 3,
          cpuPercent: 0,
          rssMb: 1220,
          processes: [],
        },
      },
      ports: [{ port: 5001, available: false, hosts: [] }],
      logs: [],
    });

    expect(health.status).toBe("warning");
    expect(health.summary).toContain("memory");
  });

  test("marks exited services as unhealthy", () => {
    const health = computeServiceHealth({
      service: { name: "api", command: "npm run api", cwd: "/app", port: 3001 },
      status: { name: "api", state: "exited", exitCode: 1 },
      ports: [],
      logs: [],
    });

    expect(health.status).toBe("unhealthy");
    expect(health.summary).toContain("exited");
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/service-health.test.ts`

Expected: FAIL because `service-health.ts` does not exist.

- [x] **Step 3: Implement health computation**

Create `src/core/service-health.ts`:

```ts
import type {
  LogEntry,
  ServiceDefinition,
  ServiceHealth,
  ServiceStatus,
} from "./types.js";
import type { PortBindingStatus } from "./port-utils.js";

export interface ComputeServiceHealthInput {
  service: ServiceDefinition;
  status?: ServiceStatus;
  ports: PortBindingStatus[];
  logs: LogEntry[];
}

export function computeServiceHealth(
  input: ComputeServiceHealthInput,
): ServiceHealth {
  const status = input.status;
  const checks: string[] = [];
  const lastErrorLog = [...input.logs]
    .reverse()
    .find((entry) => entry.stream === "stderr" || /error|failed|exception/i.test(entry.text));

  if (!status || status.state === "stopped") {
    return baseHealth(input, "unknown", "Service is not running.", lastErrorLog);
  }

  if (status.state === "exited") {
    return baseHealth(input, "unhealthy", `Service exited with code ${status.exitCode ?? "unknown"}.`, lastErrorLog);
  }

  if (status.processTree && status.processTree.rssMb >= 1000) {
    checks.push(`High memory usage: ${status.processTree.rssMb.toFixed(1)} MB RSS.`);
  }

  if (lastErrorLog) {
    checks.push(`Recent error log: ${lastErrorLog.text}`);
  }

  if (checks.length > 0) {
    return baseHealth(input, "warning", checks[0], lastErrorLog);
  }

  return baseHealth(input, "healthy", "Service is running without detected warnings.", lastErrorLog);
}

function baseHealth(
  input: ComputeServiceHealthInput,
  status: ServiceHealth["status"],
  summary: string,
  lastErrorLog?: LogEntry,
): ServiceHealth {
  return {
    service: input.service.name,
    status,
    summary,
    checkedAt: new Date().toISOString(),
    checks: [],
    processTree: input.status?.processTree,
    ports: input.ports,
    lastErrorLog,
    agentContext: "",
  };
}
```

Add the matching `ServiceHealth` type in `src/core/types.ts`.

- [x] **Step 4: Include health in dashboard payload**

In `src/web/dashboard.ts`, compute `healthByService` after runtime and ports are available:

```ts
const health = Object.fromEntries(
  config.services.map((service) => [
    service.name,
    computeServiceHealth({
      service,
      status: runtime.services[service.name],
      ports: ports.filter((port) => port.services.includes(service.name)),
      logs: options.logStore.read(service.name, 80),
    }),
  ]),
);
```

Return `health` from the dashboard payload.

- [x] **Step 5: Run tests**

Run: `npx vitest run test/service-health.test.ts test/web-server.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/core/service-health.ts src/core/types.ts src/web/dashboard.ts test/service-health.test.ts
git commit -m "feat: add service health summaries"
```

### Task 4: Add Agent Context Packets

**Files:**
- Create: `src/core/agent-context.ts`
- Modify: `src/core/service-health.ts`
- Modify: `src/mcp/tools.ts`
- Test: `test/agent-context.test.ts`

- [x] **Step 1: Write context packet test**

```ts
import { describe, expect, test } from "vitest";
import { buildServiceAgentContext } from "../src/core/agent-context.js";

describe("buildServiceAgentContext", () => {
  test("includes command, cwd, health, ports, and recent errors", () => {
    const context = buildServiceAgentContext({
      service: {
        name: "frontend",
        command: "npm run dev",
        cwd: "/repo/client",
        port: 5001,
      },
      status: { name: "frontend", state: "running", url: "http://localhost:5001/" },
      healthSummary: "High memory usage: 1220 MB RSS.",
      recentLogs: [{ service: "frontend", stream: "stderr", text: "warning", timestamp: "2026-05-18T00:00:00.000Z" }],
      timeline: [],
    });

    expect(context).toContain("frontend");
    expect(context).toContain("npm run dev");
    expect(context).toContain("/repo/client");
    expect(context).toContain("High memory usage");
    expect(context).toContain("warning");
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/agent-context.test.ts`

Expected: FAIL because `agent-context.ts` does not exist.

- [x] **Step 3: Implement context builder**

Create `src/core/agent-context.ts`:

```ts
import type {
  LogEntry,
  ServiceDefinition,
  ServiceStatus,
  TimelineEvent,
} from "./types.js";

export interface BuildServiceAgentContextInput {
  service: ServiceDefinition;
  status?: ServiceStatus;
  healthSummary: string;
  recentLogs: LogEntry[];
  timeline: TimelineEvent[];
}

export function buildServiceAgentContext(
  input: BuildServiceAgentContextInput,
): string {
  const lines = [
    `Investigate NoMoreIDE service "${input.service.name}".`,
    "",
    "Service:",
    `- kind: ${input.service.kind ?? "local"}`,
    `- command: ${"command" in input.service ? input.service.command : "docker compose service"}`,
    `- cwd: ${"cwd" in input.service ? input.service.cwd : "not applicable"}`,
    `- configured port: ${input.service.port ?? "not configured"}`,
    `- runtime url: ${input.status?.url ?? "not detected"}`,
    `- state: ${input.status?.state ?? "unknown"}`,
    "",
    "Health:",
    `- ${input.healthSummary}`,
    "",
    "Recent logs:",
    ...formatLogs(input.recentLogs),
    "",
    "Recent timeline:",
    ...formatTimeline(input.timeline),
  ];

  return `${lines.join("\n")}\n`;
}

function formatLogs(logs: LogEntry[]): string[] {
  if (logs.length === 0) return ["- none"];
  return logs.slice(-5).map((log) => `- ${log.timestamp} ${log.stream}: ${log.text}`);
}

function formatTimeline(events: TimelineEvent[]): string[] {
  if (events.length === 0) return ["- none"];
  return events.slice(-10).map((event) => `- ${event.timestamp} ${event.title}`);
}
```

- [x] **Step 4: Add MCP tool**

In `src/mcp/tools.ts`, add `nomoreide_service_context`:

```ts
{
  name: "nomoreide_service_context",
  description: "Build a copyable service health and debug context packet for an AI agent.",
  parameters: z.object({ service: z.string() }),
  execute: async ({ service }) => {
    const config = await configStore.load();
    const definition = config.services.find((item) => item.name === service);
    if (!definition) throw new Error(`Service "${service}" is not registered.`);
    const status = manager.status().services[service];
    const logs = logStore.read(service, 80);
    return buildServiceAgentContext({
      service: definition,
      status,
      healthSummary: status?.state === "running" ? "Service is running." : "Service is not running.",
      recentLogs: logs,
      timeline: [],
    });
  },
}
```

- [x] **Step 5: Run tests**

Run: `npx vitest run test/agent-context.test.ts test/mcp-server.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/core/agent-context.ts src/mcp/tools.ts test/agent-context.test.ts test/mcp-server.test.ts
git commit -m "feat: add service agent context packets"
```

### Task 5: Add Timeline Store

**Files:**
- Create: `src/core/timeline-store.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/process-manager.ts`
- Modify: `src/core/log-store.ts`
- Modify: `src/web/dashboard.ts`
- Test: `test/timeline-store.test.ts`

- [x] **Step 1: Write timeline store tests**

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TimelineStore } from "../src/core/timeline-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nomoreide-timeline-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TimelineStore", () => {
  test("appends, bounds, and persists events", async () => {
    const store = new TimelineStore({ baseDir: dir, maxEvents: 2 });
    await store.append({ kind: "service.lifecycle", severity: "info", title: "one" });
    await store.append({ kind: "service.lifecycle", severity: "info", title: "two" });
    await store.append({ kind: "service.lifecycle", severity: "info", title: "three" });

    expect(store.read().map((event) => event.title)).toEqual(["two", "three"]);
    const raw = await readFile(join(dir, "timeline.log"), "utf8");
    expect(raw).toContain("one");
    expect(raw).toContain("three");
  });
});
```

- [x] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/timeline-store.test.ts`

Expected: FAIL because `timeline-store.ts` does not exist.

- [x] **Step 3: Implement timeline store**

Create `src/core/timeline-store.ts`:

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TimelineEvent } from "./types.js";

interface TimelineStoreOptions {
  baseDir?: string;
  maxEvents?: number;
}

export class TimelineStore {
  private readonly events: TimelineEvent[] = [];
  private readonly baseDir: string;
  private readonly maxEvents: number;

  constructor(options: TimelineStoreOptions = {}) {
    this.baseDir = options.baseDir ?? ".nomoreide";
    this.maxEvents = options.maxEvents ?? 500;
  }

  async append(
    event: Omit<TimelineEvent, "id" | "timestamp"> & { timestamp?: string },
  ): Promise<TimelineEvent> {
    const completeEvent: TimelineEvent = {
      id: randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...event,
    };

    this.events.push(completeEvent);
    this.events.splice(0, Math.max(0, this.events.length - this.maxEvents));

    await mkdir(this.baseDir, { recursive: true });
    await appendFile(
      join(this.baseDir, "timeline.log"),
      `${JSON.stringify(completeEvent)}\n`,
    );

    return completeEvent;
  }

  read(limit = this.maxEvents): TimelineEvent[] {
    return this.events.slice(-limit);
  }
}
```

- [x] **Step 4: Wire lifecycle and log events**

Pass a `TimelineStore` into `ProcessManager` and `LogStore` construction. Emit:

- `service.lifecycle` when start/stop/exit happens
- `service.log` for stderr lines and selected stdout readiness lines
- `service.port` when a URL is detected

- [x] **Step 5: Include timeline in dashboard**

Return `timeline: timelineStore.read(120)` in `buildDashboardPayload`.

- [x] **Step 6: Run tests**

Run: `npx vitest run test/timeline-store.test.ts test/process-manager.test.ts test/web-server.test.ts`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/core/timeline-store.ts src/core/types.ts src/core/process-manager.ts src/core/log-store.ts src/web/dashboard.ts test/timeline-store.test.ts
git commit -m "feat: record service debug timeline"
```

### Task 6: Add Health and Timeline UI

**Files:**
- Create: `src/web/client/src/features/services/health-summary.tsx`
- Create: `src/web/client/src/features/services/debug-timeline.tsx`
- Create: `src/web/client/src/features/services/agent-context-panel.tsx`
- Modify: `src/web/client/src/features/services/services-view.tsx`
- Modify: `src/web/client/src/lib/api.ts`
- Test: `test/web-server.test.ts`

- [x] **Step 1: Add client-side types**

Update `src/web/client/src/lib/api.ts` with:

```ts
export interface DashboardServiceHealth {
  service: string;
  status: "unknown" | "healthy" | "warning" | "unhealthy";
  summary: string;
  checkedAt: string;
  agentContext: string;
}

export interface DashboardTimelineEvent {
  id: string;
  timestamp: string;
  kind: string;
  service?: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail?: string;
}
```

Add `health: Record<string, DashboardServiceHealth>` and `timeline: DashboardTimelineEvent[]` to `DashboardData`.

- [x] **Step 2: Create `HealthSummary` component**

Render status, summary, process-tree memory, CPU, and port bindings for a service.

- [x] **Step 3: Create `AgentContextPanel` component**

Render a copy button and a preformatted context packet:

```tsx
export function AgentContextPanel({ context }: { context: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Agent context</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(context);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background p-3 font-mono text-xs">
        {context}
      </pre>
    </section>
  );
}
```

- [x] **Step 4: Create `DebugTimeline` component**

Render timeline events grouped by newest-first order, with severity color and service filter. Now rendered as a visual graph (horizontal rail with severity-colored markers) plus a detail list beneath.

- [x] **Step 5: Place components in `ServicesView`**

Show health on every service row/card. Show timeline in the right panel or lower section. Show agent context for the selected service. (AgentContextPanel still pending — see Step 3.)

- [x] **Step 6: Run build**

Run: `npm run build`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/web/client/src/lib/api.ts src/web/client/src/features/services/health-summary.tsx src/web/client/src/features/services/debug-timeline.tsx src/web/client/src/features/services/agent-context-panel.tsx src/web/client/src/features/services/services-view.tsx
git commit -m "feat: show service health and debug timeline"
```

### Task 7: Add Docker Compose Service Kind

**Files:**
- Create: `src/core/docker-service-runner.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/config-store.ts`
- Modify: `src/core/process-manager.ts`
- Modify: `src/cli/commands.ts`
- Test: `test/docker-service-runner.test.ts`
- Test: `test/config-store.test.ts`

- [x] **Step 1: Add config validation tests**

Add a test that accepts:

```json
{
  "name": "api",
  "kind": "docker-compose",
  "cwd": "/repo",
  "composeFile": "docker-compose.yml",
  "composeService": "api",
  "port": 3001
}
```

Expected parsed service kind: `docker-compose`.

- [x] **Step 2: Add runner command tests**

```ts
import { describe, expect, test, vi } from "vitest";
import { createDockerComposeCommands } from "../src/core/docker-service-runner.js";

describe("docker compose commands", () => {
  test("builds start, stop, status, and logs commands", () => {
    const commands = createDockerComposeCommands({
      cwd: "/repo",
      composeFile: "docker-compose.yml",
      composeService: "api",
    });

    expect(commands.start).toEqual(["docker", ["compose", "-f", "docker-compose.yml", "up", "-d", "api"]]);
    expect(commands.stop).toEqual(["docker", ["compose", "-f", "docker-compose.yml", "stop", "api"]]);
    expect(commands.logs).toEqual(["docker", ["compose", "-f", "docker-compose.yml", "logs", "--tail", "120", "api"]]);
  });
});
```

- [x] **Step 3: Implement Docker command builder**

Create `src/core/docker-service-runner.ts` with pure command construction first. Keep execution separate so tests do not require Docker.

- [x] **Step 4: Integrate Docker services into `ProcessManager`**

For `kind: "docker-compose"`:

- `startService` runs `docker compose up -d <service>`
- `stopService` runs `docker compose stop <service>`
- `status` reads `docker compose ps --format json <service>`
- logs are loaded through `docker compose logs --tail 120 <service>`

Runtime status should not pretend Docker service has a local PID. Use:

```ts
{
  name,
  state: "running",
  containerId,
  startedAt,
}
```

- [x] **Step 5: Add CLI registration**

Support:

```bash
nomoreide add service api \
  --kind docker-compose \
  --cwd /repo \
  --compose-file docker-compose.yml \
  --compose-service api \
  --port 3001
```

- [x] **Step 6: Run tests**

Run: `npx vitest run test/docker-service-runner.test.ts test/config-store.test.ts test/cli.test.ts`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/core/docker-service-runner.ts src/core/types.ts src/core/config-store.ts src/core/process-manager.ts src/cli/commands.ts test/docker-service-runner.test.ts test/config-store.test.ts test/cli.test.ts
git commit -m "feat: support docker compose services"
```

### Task 8: Add SSH Service Kind

**Files:**
- Create: `src/core/ssh-service-runner.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/config-store.ts`
- Modify: `src/core/process-manager.ts`
- Modify: `src/cli/commands.ts`
- Test: `test/ssh-service-runner.test.ts`
- Test: `test/config-store.test.ts`

- [x] **Step 1: Add config validation tests**

Accept:

```json
{
  "name": "staging-api",
  "kind": "ssh",
  "host": "devbox",
  "cwd": "/srv/app",
  "command": "npm run dev",
  "port": 3001
}
```

Reject services with:

- empty host
- command containing a null byte
- missing cwd

- [x] **Step 2: Add SSH command construction tests**

```ts
import { describe, expect, test } from "vitest";
import { createSshCommand } from "../src/core/ssh-service-runner.js";

describe("createSshCommand", () => {
  test("uses existing ssh config and runs command in cwd", () => {
    expect(
      createSshCommand({
        host: "devbox",
        cwd: "/srv/app",
        command: "npm run dev",
      }),
    ).toEqual([
      "ssh",
      ["devbox", "cd /srv/app && exec npm run dev"],
    ]);
  });
});
```

- [x] **Step 3: Implement SSH runner**

Create `src/core/ssh-service-runner.ts`:

```ts
export interface SshCommandInput {
  host: string;
  cwd: string;
  command: string;
}

export function createSshCommand(input: SshCommandInput): [string, string[]] {
  validateSshInput(input);
  return ["ssh", [input.host, `cd ${shellEscape(input.cwd)} && exec ${input.command}`]];
}

function validateSshInput(input: SshCommandInput): void {
  if (!input.host.trim()) throw new Error("SSH host is required.");
  if (!input.cwd.trim()) throw new Error("SSH cwd is required.");
  if (input.command.includes("\0")) throw new Error("SSH command contains invalid null byte.");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
```

- [x] **Step 4: Integrate SSH services**

For `kind: "ssh"`, `ProcessManager` should spawn `ssh host "cd cwd && exec command"` locally. The root PID is the local ssh process. NoMoreIDE must label the service as remote in status and UI.

- [x] **Step 5: Add safety warnings in UI**

In the service card, display:

```text
Remote service on devbox
Commands run through your local SSH config and SSH agent.
```

- [x] **Step 6: Add CLI registration**

Support:

```bash
nomoreide add service staging-api \
  --kind ssh \
  --host devbox \
  --cwd /srv/app \
  --command "npm run dev" \
  --port 3001
```

- [x] **Step 7: Run tests**

Run: `npx vitest run test/ssh-service-runner.test.ts test/config-store.test.ts test/cli.test.ts`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/core/ssh-service-runner.ts src/core/types.ts src/core/config-store.ts src/core/process-manager.ts src/cli/commands.ts test/ssh-service-runner.test.ts test/config-store.test.ts test/cli.test.ts
git commit -m "feat: support ssh remote services"
```

### Task 9: Add MCP Tools for Health, Timeline, and Remote-Aware Services

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `test/mcp-server.test.ts`

- [x] **Step 1: Add tests for new MCP tool names**

Expected tools:

```ts
[
  "nomoreide_service_health",
  "nomoreide_service_context",
  "nomoreide_timeline",
]
```

- [x] **Step 2: Implement `nomoreide_service_health`**

Parameters:

```ts
z.object({
  service: z.string().optional(),
})
```

Behavior:

- when `service` is provided, return one health summary
- when omitted, return all service health summaries

- [x] **Step 3: Implement `nomoreide_timeline`**

Parameters:

```ts
z.object({
  service: z.string().optional(),
  limit: z.number().int().positive().max(200).default(80),
})
```

Behavior:

- return newest timeline events
- filter by service if provided

- [x] **Step 4: Run tests**

Run: `npx vitest run test/mcp-server.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/mcp/tools.ts test/mcp-server.test.ts
git commit -m "feat: expose health and timeline over mcp"
```

### Task 10: Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-05-18-runtime-health-debug-timeline-remote-services.md`

- [x] **Step 1: Document local health features**

Add README examples:

```bash
nomoreide health
nomoreide timeline
nomoreide context jobjourney-frontend
```

- [x] **Step 2: Document Docker service config**

Add:

```bash
nomoreide add service api \
  --kind docker-compose \
  --cwd ./infra \
  --compose-file docker-compose.yml \
  --compose-service api \
  --port 3001
```

- [x] **Step 3: Document SSH service config**

Add:

```bash
nomoreide add service staging-api \
  --kind ssh \
  --host devbox \
  --cwd /srv/app \
  --command "npm run dev" \
  --port 3001
```

- [x] **Step 4: Run full verification**

Run:

```bash
npm test
npm run build
```

Expected: both pass.

- [x] **Step 5: Commit**

```bash
git add README.md docs/superpowers/plans/2026-05-18-runtime-health-debug-timeline-remote-services.md
git commit -m "docs: document runtime health roadmap"
```

---

## Risk Notes

- **Docker:** Do not require Docker to be installed for unit tests. Keep command construction pure and mock execution.
- **SSH:** Do not store passwords. Use the user's existing SSH config and SSH agent only.
- **Remote safety:** Always show remote host in UI and MCP responses so local and remote actions cannot be confused.
- **Port detection:** Host binding behavior differs between macOS, Linux, and Docker. Keep host-level details visible instead of flattening to one boolean only.
- **Resource metrics:** CPU and RSS snapshots are approximate. Present them as observability hints, not exact billing-grade telemetry.
- **Timeline volume:** Keep timeline bounded in memory. Persist append-only logs on disk for inspection.

## Milestone Order

1. Port detection fix
2. Process tree resource snapshots
3. Service health summaries
4. Agent context packets
5. Timeline store
6. Health and timeline UI
7. Docker Compose services
8. SSH remote services
9. MCP health/timeline tools
10. Documentation and full verification

This order keeps each milestone useful on its own and avoids building remote execution before NoMoreIDE has the health model needed to explain what remote services are doing.

---

## Self-Review

- **Spec coverage:** Covers service health, agent context, debug timeline, Docker services, SSH services, MCP exposure, UI, CLI, and docs.
- **Placeholder scan:** No placeholder sections are left for implementers; each task defines files, commands, expected results, and concrete implementation shape.
- **Type consistency:** Service kind, health, process tree, and timeline types are named consistently across tasks.
