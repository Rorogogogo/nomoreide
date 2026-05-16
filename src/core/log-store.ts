import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry, LogStream } from "./types.js";

interface LogStoreOptions {
  baseDir?: string;
  maxLinesPerService?: number;
}

export class LogStore {
  private readonly entriesByService = new Map<string, LogEntry[]>();
  private readonly baseDir: string;
  private readonly maxLinesPerService: number;

  constructor(options: LogStoreOptions = {}) {
    this.baseDir = options.baseDir ?? ".nomoreide/logs";
    this.maxLinesPerService = options.maxLinesPerService ?? 500;
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

    return entry;
  }

  read(service: string, limit = this.maxLinesPerService): LogEntry[] {
    return (this.entriesByService.get(service) ?? []).slice(-limit);
  }
}

function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}
