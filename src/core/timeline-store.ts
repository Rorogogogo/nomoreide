import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
