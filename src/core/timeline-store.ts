import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TimelineEvent } from "./types.js";

interface TimelineStoreOptions {
  baseDir?: string;
  maxEvents?: number;
}

type TimelineListener = (event: TimelineEvent) => void;

export class TimelineStore {
  private readonly events: TimelineEvent[] = [];
  private readonly baseDir: string;
  private readonly maxEvents: number;
  private readonly listeners = new Set<TimelineListener>();

  constructor(options: TimelineStoreOptions = {}) {
    this.baseDir = options.baseDir ?? ".nomoreide";
    this.maxEvents = options.maxEvents ?? 500;
  }

  /** Notified after each appended event — the central app event bus. */
  subscribe(listener: TimelineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

    for (const listener of this.listeners) listener(completeEvent);
    return completeEvent;
  }

  read(limit = this.maxEvents): TimelineEvent[] {
    return this.events.slice(-limit);
  }
}
