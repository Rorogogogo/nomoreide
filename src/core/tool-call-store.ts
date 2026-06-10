export interface ToolCallRecord {
  id: number;
  tool: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
  /** Agent session this call belongs to (see core/agent-sessions.ts). */
  sessionId?: string;
  args?: string;
  error?: string;
}

type Listener = (record: ToolCallRecord) => void;

export class ToolCallStore {
  private readonly records: ToolCallRecord[] = [];
  private readonly listeners = new Set<Listener>();
  private nextId = 1;

  constructor(private readonly capacity = 200) {}

  record(entry: Omit<ToolCallRecord, "id">): ToolCallRecord {
    const record: ToolCallRecord = { id: this.nextId++, ...entry };
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // ignore listener errors
      }
    }
    return record;
  }

  recent(limit = 100): ToolCallRecord[] {
    if (limit >= this.records.length) return [...this.records];
    return this.records.slice(this.records.length - limit);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const ARG_PREVIEW_BYTES = 240;

export function previewArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  try {
    const json = typeof args === "string" ? args : JSON.stringify(args);
    if (!json) return undefined;
    if (json.length <= ARG_PREVIEW_BYTES) return json;
    return `${json.slice(0, ARG_PREVIEW_BYTES)}…`;
  } catch {
    return undefined;
  }
}
