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
    `- command: ${input.service.command}`,
    `- cwd: ${input.service.cwd}`,
    `- configured port: ${input.service.port ?? "not configured"}`,
    `- runtime url: ${input.status?.url ?? "not detected"}`,
    `- state: ${input.status?.state ?? "unknown"}`,
    `- pid: ${input.status?.pid ?? "n/a"}`,
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
  const significant = logs.filter(
    (entry) => entry.stream === "stderr" || /error|warn|fail|exception/i.test(entry.text),
  );
  const source = significant.length > 0 ? significant : logs;
  if (source.length === 0) return ["- none"];
  return source
    .slice(-8)
    .map((entry) => `- ${entry.timestamp} ${entry.stream}: ${entry.text}`);
}

function formatTimeline(events: TimelineEvent[]): string[] {
  if (events.length === 0) return ["- none"];
  return events
    .slice(-10)
    .map((event) => {
      const detail = event.detail ? ` — ${event.detail}` : "";
      return `- ${event.timestamp} [${event.severity}] ${event.title}${detail}`;
    });
}
