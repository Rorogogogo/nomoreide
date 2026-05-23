import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TimelineStore } from "./timeline-store.js";
import type { LogEntry, LogStream } from "./types.js";

interface LogStoreOptions {
  baseDir?: string;
  maxLinesPerService?: number;
  timelineStore?: TimelineStore;
}

type LogListener = (entry: LogEntry) => void;

export class LogStore {
  private readonly entriesByService = new Map<string, LogEntry[]>();
  private readonly baseDir: string;
  private readonly maxLinesPerService: number;
  private readonly timelineStore?: TimelineStore;
  private readonly listeners = new Set<LogListener>();

  constructor(options: LogStoreOptions = {}) {
    this.baseDir = options.baseDir ?? ".nomoreide/logs";
    this.maxLinesPerService = options.maxLinesPerService ?? 500;
    this.timelineStore = options.timelineStore;
  }

  /** Observe every appended line. Returns an unsubscribe fn. */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async append(
    service: string,
    stream: LogStream,
    text: string,
  ): Promise<LogEntry> {
    const entry: LogEntry = {
      service,
      stream,
      text,
      timestamp: new Date().toISOString(),
    };

    const entries = this.entriesByService.get(service) ?? [];
    entries.push(entry);
    this.entriesByService.set(
      service,
      entries.slice(-this.maxLinesPerService),
    );

    await mkdir(this.baseDir, { recursive: true });
    await appendFile(
      join(this.baseDir, `${safeFileName(service)}.log`),
      `${JSON.stringify(entry)}\n`,
    );

    await this.appendTimelineEvent(entry);
    this.emit(entry);

    return entry;
  }

  private emit(entry: LogEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // ignore listener errors
      }
    }
  }

  read(service: string, limit = this.maxLinesPerService): LogEntry[] {
    return (this.entriesByService.get(service) ?? []).slice(-limit);
  }

  private async appendTimelineEvent(entry: LogEntry): Promise<void> {
    if (!this.timelineStore) return;
    const severity = classifyLogSeverity(entry.text);
    const isReadiness = isReadinessLine(entry.text);
    if (severity === null && !isReadiness) return;

    await this.timelineStore.append({
      kind: "service.log",
      service: entry.service,
      severity: severity ?? "info",
      title: `${entry.service} ${entry.stream}`,
      detail: entry.text,
      timestamp: entry.timestamp,
    });
  }
}

function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isReadinessLine(text: string): boolean {
  return /\b(ready|listening|local:|server started)\b/i.test(text);
}

function classifyLogSeverity(text: string): "warning" | "error" | null {
  if (/\b(panic|fatal|traceback|uncaught|unhandled|EADDRINUSE|ECONNREFUSED|segmentation fault)\b/i.test(text)) {
    return "error";
  }
  if (/\berror\b/i.test(text) && !/0 errors?\b/i.test(text)) {
    return "error";
  }
  if (/\b(warn|warning|deprecated)\b/i.test(text)) {
    return "warning";
  }
  return null;
}
