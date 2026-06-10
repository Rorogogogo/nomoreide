import type { FastMCP } from "fastmcp";
import type { AgentSessionTracker } from "../../core/agent-sessions.js";
import type { ConfigStore } from "../../core/config-store.js";
import type { DbPeek } from "../../core/db-peek.js";
import type { ErrorInbox } from "../../core/error-inbox.js";
import { GitActions } from "../../core/git-actions.js";
import { GitManager } from "../../core/git-manager.js";
import type { LogStore } from "../../core/log-store.js";
import type { ProcessManager } from "../../core/process-manager.js";
import type { TimelineStore } from "../../core/timeline-store.js";
import { previewArgs, type ToolCallStore } from "../../core/tool-call-store.js";
import type { UiLifecycleManager } from "../../web/ui-lifecycle.js";

/** Shared stateful services every tool group receives. */
export interface ToolContext {
  configStore: ConfigStore;
  dbPeek: DbPeek;
  errorInbox: ErrorInbox;
  logStore: LogStore;
  manager: ProcessManager;
  timelineStore: TimelineStore;
  uiLifecycle: UiLifecycleManager;
}

/** Each domain registers its tools onto the (optionally recording) server. */
export type RegisterTools = (server: FastMCP, ctx: ToolContext) => void;

export function git(cwd?: string): GitManager {
  return new GitManager(cwd ?? process.cwd());
}

/** Write-capable Git ops (push) — kept distinct from the read-safe {@link git}. */
export function gitActions(cwd?: string): GitActions {
  return new GitActions(cwd ?? process.cwd());
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Wrap a FastMCP server so every `addTool` execute is timed and recorded in
 * the tool-call store. The aggregator wraps once, then hands the same wrapped
 * server to each domain's `registerXTools`.
 *
 * When a session tracker is supplied, every execute first runs
 * `beforeToolCall()` — which auto-snapshots the working tree at the start of
 * a new agent session — and the resulting sessionId tags each record.
 */
export function wrapServerForRecording(
  server: FastMCP,
  store: ToolCallStore,
  sessions?: AgentSessionTracker,
): FastMCP {
  const originalAdd = server.addTool.bind(server);
  const wrapped = (definition: Parameters<FastMCP["addTool"]>[0]) => {
    const originalExecute = definition.execute;
    const recordingDefinition = {
      ...definition,
      execute: async (args: unknown, context: unknown) => {
        const sessionId = sessions ? await sessions.beforeToolCall() : undefined;
        const start = Date.now();
        const startedAt = new Date(start).toISOString();
        try {
          const result = await (originalExecute as (
            a: unknown,
            c: unknown,
          ) => Promise<unknown>)(args, context);
          store.record({
            tool: definition.name,
            startedAt,
            durationMs: Date.now() - start,
            status: "ok",
            sessionId,
            args: previewArgs(args),
          });
          return result as ReturnType<typeof originalExecute>;
        } catch (error) {
          store.record({
            tool: definition.name,
            startedAt,
            durationMs: Date.now() - start,
            status: "error",
            sessionId,
            args: previewArgs(args),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    } as Parameters<FastMCP["addTool"]>[0];
    return originalAdd(recordingDefinition);
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "addTool") return wrapped;
      return Reflect.get(target, prop, receiver);
    },
  });
}
