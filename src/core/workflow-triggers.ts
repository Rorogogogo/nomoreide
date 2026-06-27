import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConfigStore } from "./config-store.js";
import type { ErrorIncident, ErrorInbox } from "./error-inbox.js";
import type { TimelineStore } from "./timeline-store.js";
import type { TimelineEvent } from "./types.js";

/**
 * Event-driven workflow triggers (IDEAS #16). Workflows are user-run today; a
 * trigger binds an app-detected event to a workflow so it fires automatically.
 *
 * The workflow runner lives client-side (agent steps run through the dock), so a
 * trigger can't run a workflow on the server. Instead a fired trigger enqueues a
 * **pending run** here; the open dashboard drains the queue and drives the
 * existing client runner. Pending runs survive until a browser claims them, so
 * an event detected while no tab is open isn't lost.
 *
 * Live event sources are the two already push-based and in-process:
 * - `error-incident` — {@link ErrorInbox} surfaces a new/repeated incident.
 * - `service-crash`   — {@link TimelineStore} records a `service.lifecycle`
 *   event with `severity: "error"` (non-zero exit not initiated by the user).
 */

export const triggerEventSchema = z.enum(["error-incident", "service-crash"]);
export type TriggerEvent = z.infer<typeof triggerEventSchema>;

export const workflowTriggerSchema = z.object({
  id: z.string().min(1),
  /** The workflow (built-in or user-saved) to run when this fires. */
  workflowId: z.string().min(1),
  event: triggerEventSchema,
  /** Disabled triggers stay configured but never fire. */
  enabled: z.boolean().default(true),
  /**
   * Optional case-insensitive substring matched against the event's service
   * name (and, for incidents, the incident title). Empty/absent = match all.
   */
  filter: z.string().optional(),
  /**
   * When true the dashboard starts the run automatically; otherwise the pending
   * run is surfaced for the user to start with one click.
   */
  autoRun: z.boolean().default(false),
});

export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export interface PendingRun {
  id: string;
  triggerId: string;
  workflowId: string;
  event: TriggerEvent;
  /** Human-readable reason this fired, shown in the dashboard. */
  summary: string;
  /** `triggerId:cause` dedupe key, collapsing a burst into one pending run. */
  signature: string;
  autoRun: boolean;
  createdAt: string;
}

type PendingListener = (pending: PendingRun) => void;

interface WorkflowTriggerManagerOptions {
  configStore: ConfigStore;
  errorInbox: ErrorInbox;
  timelineStore: TimelineStore;
  /** Max pending runs kept; older ones drop off the front. */
  capacity?: number;
  /** A repeat of the same signature within this window is ignored. */
  dedupeWindowMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class WorkflowTriggerManager {
  private readonly configStore: ConfigStore;
  private readonly errorInbox: ErrorInbox;
  private readonly timelineStore: TimelineStore;
  private readonly capacity: number;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;

  private readonly pending: PendingRun[] = [];
  private readonly lastFiredAt = new Map<string, number>();
  private readonly listeners = new Set<PendingListener>();
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(options: WorkflowTriggerManagerOptions) {
    this.configStore = options.configStore;
    this.errorInbox = options.errorInbox;
    this.timelineStore = options.timelineStore;
    this.capacity = options.capacity ?? 50;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Subscribe to the live event sources. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribers.push(
      this.errorInbox.subscribe((incident) => {
        void this.onIncident(incident);
      }),
    );
    this.unsubscribers.push(
      this.timelineStore.subscribe((event) => {
        void this.onTimelineEvent(event);
      }),
    );
  }

  stop(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    this.started = false;
  }

  subscribe(listener: PendingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Pending runs, newest first. */
  listPending(): PendingRun[] {
    return [...this.pending].reverse();
  }

  /** Drop a pending run once the dashboard has started (or dismissed) it. */
  ackPending(id: string): boolean {
    const index = this.pending.findIndex((run) => run.id === id);
    if (index === -1) return false;
    this.pending.splice(index, 1);
    return true;
  }

  private async onIncident(incident: ErrorIncident): Promise<void> {
    const triggers = await this.triggersFor("error-incident");
    const haystack = `${incident.service} ${incident.title}`;
    for (const trigger of triggers) {
      if (!matchesFilter(trigger.filter, haystack)) continue;
      this.enqueue(trigger, {
        signatureCause: `incident:${incident.signature}`,
        summary: `${incident.service}: ${incident.title}`,
      });
    }
  }

  private async onTimelineEvent(event: TimelineEvent): Promise<void> {
    if (event.kind !== "service.lifecycle" || event.severity !== "error") return;
    const service = event.service ?? "";
    const triggers = await this.triggersFor("service-crash");
    for (const trigger of triggers) {
      if (!matchesFilter(trigger.filter, service)) continue;
      this.enqueue(trigger, {
        signatureCause: `crash:${service}`,
        summary: event.title || `${service} crashed`,
      });
    }
  }

  private async triggersFor(event: TriggerEvent): Promise<WorkflowTrigger[]> {
    const config = await this.configStore.load();
    return config.workflowTriggers.filter(
      (trigger) => trigger.enabled && trigger.event === event,
    );
  }

  private enqueue(
    trigger: WorkflowTrigger,
    cause: { signatureCause: string; summary: string },
  ): void {
    const signature = `${trigger.id}:${cause.signatureCause}`;
    const at = this.now();
    const previous = this.lastFiredAt.get(signature);
    if (previous !== undefined && at - previous < this.dedupeWindowMs) return;
    this.lastFiredAt.set(signature, at);

    const run: PendingRun = {
      id: randomUUID(),
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      event: trigger.event,
      summary: cause.summary,
      signature,
      autoRun: trigger.autoRun,
      createdAt: new Date(at).toISOString(),
    };
    this.pending.push(run);
    this.pending.splice(0, Math.max(0, this.pending.length - this.capacity));
    for (const listener of this.listeners) listener(run);
  }
}

function matchesFilter(filter: string | undefined, haystack: string): boolean {
  const needle = filter?.trim().toLowerCase();
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle);
}
