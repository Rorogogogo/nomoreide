import { buildServiceAgentContext } from "./agent-context.js";
import type { PortBindingStatus } from "./port-utils.js";
import type {
  LogEntry,
  ServiceDefinition,
  ServiceHealth,
  ServiceStatus,
  TimelineEvent,
} from "./types.js";

export interface ComputeServiceHealthInput {
  service: ServiceDefinition;
  status?: ServiceStatus;
  ports: PortBindingStatus[];
  logs: LogEntry[];
  timeline?: TimelineEvent[];
}

// Many runtimes (Go's log package, cargo, dotnet) write routine output to
// stderr, so only the text can tell an error apart from an info line.
const ERROR_LOG_PATTERN =
  /error|failed|exception|panic|fatal|traceback|exit status/i;

export function computeServiceHealth(
  input: ComputeServiceHealthInput,
): ServiceHealth {
  const status = input.status;
  const startedAt = status?.startedAt;
  const lastErrorLog = [...input.logs]
    .reverse()
    .find(
      (entry) =>
        ERROR_LOG_PATTERN.test(entry.text) &&
        (!startedAt || entry.timestamp >= startedAt),
    );

  if (!status || status.state === "stopped") {
    return baseHealth(input, "unknown", "Service is not running.", lastErrorLog);
  }

  if (status.state === "exited") {
    return baseHealth(
      input,
      "unhealthy",
      `Service exited with code ${status.exitCode ?? "unknown"}.`,
      lastErrorLog,
    );
  }

  if (status.processTree && status.processTree.rssMb >= 1000) {
    return baseHealth(
      input,
      "warning",
      `High memory usage: ${status.processTree.rssMb.toFixed(1)} MB RSS.`,
      lastErrorLog,
    );
  }

  if (lastErrorLog) {
    return baseHealth(
      input,
      "warning",
      `Recent error log: ${lastErrorLog.text}`,
      lastErrorLog,
    );
  }

  return baseHealth(
    input,
    "healthy",
    "Service is running without detected warnings.",
    lastErrorLog,
  );
}

function baseHealth(
  input: ComputeServiceHealthInput,
  status: ServiceHealth["status"],
  summary: string,
  lastErrorLog?: LogEntry,
): ServiceHealth {
  const agentContext = buildServiceAgentContext({
    service: input.service,
    status: input.status,
    healthSummary: summary,
    recentLogs: input.logs,
    timeline: input.timeline ?? [],
  });
  return {
    service: input.service.name,
    status,
    summary,
    checkedAt: new Date().toISOString(),
    checks: [],
    processTree: input.status?.processTree,
    ports: input.ports,
    lastErrorLog,
    agentContext,
  };
}
