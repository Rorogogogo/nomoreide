import { isAbsolute, resolve } from "node:path";
import type { ConfigStore } from "./config-store.js";
import { GitManager } from "./git-manager.js";
import type { LogStore } from "./log-store.js";
import type { LogEntry } from "./types.js";

export type IncidentLevel = "error" | "warning";

export interface ErrorIncident {
  id: number;
  service: string;
  level: IncidentLevel;
  /** Stable dedupe key derived from the trigger line. */
  signature: string;
  /** The trigger line, trimmed. */
  title: string;
  /** Top stack frame, if one was found near the trigger. */
  file?: string;
  line?: number;
  firstSeen: string;
  lastSeen: string;
  count: number;
  /** The trigger line plus the surrounding log context. */
  logExcerpt: string[];
}

export interface ErrorInboxPrompt {
  incident: ErrorIncident;
  /** Resolved file path used for the diff, if any. */
  file?: string;
  /** Markdown payload ready to paste into an agent. */
  prompt: string;
}

interface ErrorInboxOptions {
  logStore: LogStore;
  configStore: ConfigStore;
  /** Repo/workspace root used when a service has no own cwd. */
  cwd?: string;
  /** Max distinct incidents kept in the ring buffer. */
  capacity?: number;
}

type IncidentListener = (incident: ErrorIncident) => void;

/** Lines of surrounding context captured with each incident. */
const CONTEXT_LINES = 12;
/** How many follow-up lines after a trigger are absorbed as stack frames. */
const FRAME_FOLLOW = 12;
const TITLE_MAX = 240;
const PROMPT_LOG_LINES = 40;

interface ServiceState {
  recent: string[];
  active?: { id: number; remaining: number };
}

/**
 * Watches every log line via {@link LogStore.subscribe}, distils error and
 * stack-trace lines into deduped incidents, and assembles a copy-to-agent
 * prompt (incident + affected-file diff + recent logs) on demand.
 */
export class ErrorInbox {
  private readonly logStore: LogStore;
  private readonly configStore: ConfigStore;
  private readonly cwd: string;
  private readonly capacity: number;

  private readonly incidents: ErrorIncident[] = [];
  private readonly byId = new Map<number, ErrorIncident>();
  private readonly bySignature = new Map<string, ErrorIncident>();
  private readonly stateByService = new Map<string, ServiceState>();
  private readonly listeners = new Set<IncidentListener>();
  private nextId = 1;
  private readonly unsubscribe: () => void;

  constructor(options: ErrorInboxOptions) {
    this.logStore = options.logStore;
    this.configStore = options.configStore;
    this.cwd = options.cwd ?? process.cwd();
    this.capacity = options.capacity ?? 100;
    this.unsubscribe = this.logStore.subscribe((entry) => {
      this.ingest(entry);
    });
  }

  /** Stop observing the log store. */
  dispose(): void {
    this.unsubscribe();
  }

  list(limit = this.capacity): ErrorIncident[] {
    const sorted = [...this.incidents].sort((a, b) =>
      a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : b.id - a.id,
    );
    return sorted.slice(0, limit);
  }

  get(id: number): ErrorIncident | undefined {
    return this.byId.get(id);
  }

  subscribe(listener: IncidentListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Feed one log line through the detectors. Returns a touched incident, if any. */
  ingest(entry: LogEntry): ErrorIncident | null {
    const text = entry.text;
    const state = this.stateFor(entry.service);
    state.recent.push(text);
    if (state.recent.length > CONTEXT_LINES) state.recent.shift();

    const frame = extractFrame(text);

    // Absorb stack frames / continuation lines into the active incident.
    if (state.active && state.active.remaining > 0 && (frame || isStackFrame(text))) {
      const incident = this.byId.get(state.active.id);
      if (incident) {
        incident.logExcerpt.push(text);
        incident.lastSeen = entry.timestamp;
        if (incident.file === undefined && frame) {
          incident.file = frame.file;
          incident.line = frame.line;
        }
        state.active.remaining -= 1;
        this.emit(incident);
      }
      return incident ?? null;
    }

    // Bare frames without a preceding header aren't their own incidents.
    if (isStackFrame(text)) return null;

    const level = classifyLine(text);
    if (level === null) return null;

    return this.recordIncident(entry, level, frame, state);
  }

  private recordIncident(
    entry: LogEntry,
    level: IncidentLevel,
    frame: { file: string; line: number } | null,
    state: ServiceState,
  ): ErrorIncident {
    const signature = `${entry.service} ${normalizeSignature(entry.text)}`;
    const existing = this.bySignature.get(signature);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = entry.timestamp;
      existing.level = level;
      existing.logExcerpt = [...state.recent];
      if (frame) {
        existing.file = frame.file;
        existing.line = frame.line;
      }
      state.active = { id: existing.id, remaining: FRAME_FOLLOW };
      this.emit(existing);
      return existing;
    }

    // The header line often has no frame of its own (e.g. a Python
    // `ValueError` printed after its `File "…"` frames). Fall back to the
    // most recent frame in the surrounding context.
    const resolvedFrame = frame ?? lastFrameIn(state.recent);

    const incident: ErrorIncident = {
      id: this.nextId++,
      service: entry.service,
      level,
      signature,
      title: entry.text.trim().slice(0, TITLE_MAX),
      file: resolvedFrame?.file,
      line: resolvedFrame?.line,
      firstSeen: entry.timestamp,
      lastSeen: entry.timestamp,
      count: 1,
      logExcerpt: [...state.recent],
    };

    this.incidents.push(incident);
    this.byId.set(incident.id, incident);
    this.bySignature.set(signature, incident);
    this.evictOverflow();
    state.active = { id: incident.id, remaining: FRAME_FOLLOW };
    this.emit(incident);
    return incident;
  }

  /** Assemble the copy-to-agent payload for an incident. */
  async buildPrompt(id: number): Promise<ErrorInboxPrompt | null> {
    const incident = this.byId.get(id);
    if (!incident) return null;

    const serviceCwd = await this.serviceCwd(incident.service);
    const resolvedFile = incident.file
      ? isAbsolute(incident.file)
        ? incident.file
        : resolve(serviceCwd, incident.file)
      : undefined;

    let diff = "";
    if (incident.file) {
      try {
        diff = await new GitManager(serviceCwd).diff(incident.file);
      } catch {
        diff = "";
      }
    }

    const recentLogs = this.logStore
      .read(incident.service, PROMPT_LOG_LINES)
      .map((entry) => entry.text);

    return {
      incident,
      file: resolvedFile,
      prompt: renderPrompt(incident, resolvedFile, diff, recentLogs),
    };
  }

  private async serviceCwd(service: string): Promise<string> {
    // Test-runner incidents are tagged `<service>:test`; resolve the base
    // service so the affected-file diff still uses its working directory.
    const baseService = service.replace(/:test$/, "");
    try {
      const config = await this.configStore.load();
      const definition = config.services.find((item) => item.name === baseService);
      if (definition?.cwd) {
        return isAbsolute(definition.cwd)
          ? definition.cwd
          : resolve(this.cwd, definition.cwd);
      }
    } catch {
      // fall through to the workspace root
    }
    return this.cwd;
  }

  private stateFor(service: string): ServiceState {
    let state = this.stateByService.get(service);
    if (!state) {
      state = { recent: [] };
      this.stateByService.set(service, state);
    }
    return state;
  }

  private evictOverflow(): void {
    while (this.incidents.length > this.capacity) {
      const dropped = this.incidents.shift();
      if (!dropped) break;
      this.byId.delete(dropped.id);
      if (this.bySignature.get(dropped.signature) === dropped) {
        this.bySignature.delete(dropped.signature);
      }
    }
  }

  private emit(incident: ErrorIncident): void {
    for (const listener of this.listeners) {
      try {
        listener(incident);
      } catch {
        // ignore listener errors
      }
    }
  }
}

// `traceback` is intentionally absent: it's a stack opener, not the error
// message itself — the real exception arrives a few lines later (see the
// look-back in recordIncident, which pulls the frame from those lines).
const FATAL = /\b(panic|fatal|uncaught|unhandled|EADDRINUSE|ECONNREFUSED|segmentation fault|exception in thread)\b/i;
// Bare `error` plus typed headers like `TypeError:` / `ValueError` / `Exception`.
const ERROR_WORD = /\b\w*(?:error|exception)\b/i;
const NO_ERRORS = /\b0 errors?\b/i;
const WARN = /\b(warn|warning|deprecated)\b/i;

function classifyLine(text: string): IncidentLevel | null {
  if (FATAL.test(text)) return "error";
  if (ERROR_WORD.test(text) && !NO_ERRORS.test(text)) return "error";
  if (WARN.test(text)) return "warning";
  return null;
}

const PY_FRAME = /File "([^"]+)", line (\d+)/;
const JS_FRAME = /\(?([^\s()]+\.(?:[cm]?[jt]sx?)):(\d+):\d+\)?/;

function extractFrame(text: string): { file: string; line: number } | null {
  const py = PY_FRAME.exec(text);
  if (py) return { file: py[1], line: Number(py[2]) };
  const js = JS_FRAME.exec(text);
  if (js) return { file: js[1], line: Number(js[2]) };
  return null;
}

/** Most recent extractable frame in a context window (newest line last). */
function lastFrameIn(lines: string[]): { file: string; line: number } | null {
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i--) {
    const frame = extractFrame(lines[i]);
    if (frame) return frame;
  }
  return null;
}

function isStackFrame(text: string): boolean {
  return /^\s*(at\s+|File\s+"|Caused by:|\.\.\.\s+\d+\s+more|--- End of)/.test(text);
}

/** Collapse volatile bits (timestamps, numbers, hex, quoted values) so repeats dedupe. */
function normalizeSignature(text: string): string {
  return text
    .trim()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ][\d:.,]+z?\b/gi, "<ts>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 200)
    .toLowerCase();
}

function renderPrompt(
  incident: ErrorIncident,
  file: string | undefined,
  diff: string,
  recentLogs: string[],
): string {
  const parts: string[] = [];
  parts.push(`I hit an error in my **${incident.service}** service. Help me fix it.`);
  parts.push("");
  parts.push("## Error");
  parts.push("```");
  parts.push(...incident.logExcerpt);
  parts.push("```");
  if (file) {
    parts.push("");
    parts.push(`Affected file: \`${file}\`${incident.line ? ` (line ${incident.line})` : ""}`);
  }
  if (diff.trim()) {
    parts.push("");
    parts.push("## Current diff of the affected file");
    parts.push("```diff");
    parts.push(diff.trimEnd());
    parts.push("```");
  }
  if (recentLogs.length) {
    parts.push("");
    parts.push(`## Last ${recentLogs.length} log lines from ${incident.service}`);
    parts.push("```");
    parts.push(...recentLogs);
    parts.push("```");
  }
  return parts.join("\n");
}
