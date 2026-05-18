import type { PortBindingStatus } from "./port-utils.js";
import type {
  LogEntry,
  ServiceDefinition,
  ServiceHealth,
  ServiceStatus,
} from "./types.js";

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
  const lastErrorLog = [...input.logs]
    .reverse()
    .find(
      (entry) =>
        entry.stream === "stderr" || /error|failed|exception/i.test(entry.text),
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
