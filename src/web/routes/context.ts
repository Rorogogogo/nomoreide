import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalBroker } from "../../core/approval-broker.js";
import type { ConfigStore } from "../../core/config-store.js";
import type { DbPeek } from "../../core/db-peek.js";
import type { ErrorInbox } from "../../core/error-inbox.js";
import type { LogStore } from "../../core/log-store.js";
import type { ProcessManager } from "../../core/process-manager.js";
import type { ReproBundleBuilder } from "../../core/repro-bundle.js";
import type { TestRunner } from "../../core/test-runner.js";
import type { TerminalSessionManagerLike } from "../../core/terminal-manager.js";
import type { TimelineStore } from "../../core/timeline-store.js";
import type { ToolCallStore } from "../../core/tool-call-store.js";

/** Shared stateful services every route handler receives. */
export interface RouteServices {
  agentApprovals: ApprovalBroker;
  configStore: ConfigStore;
  cwd: string;
  dbPeek: DbPeek;
  errorInbox: ErrorInbox;
  logStore: LogStore;
  manager: ProcessManager;
  reproBundle: ReproBundleBuilder;
  testRunner: TestRunner;
  terminalManager: TerminalSessionManagerLike;
  timelineStore: TimelineStore;
  toolCallStore: ToolCallStore;
}

/** Per-request context handed to a route handler. */
export interface RequestContext extends RouteServices {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

export interface Route {
  /** Returns matched path params when this route handles the request, else null. */
  match(method: string, url: URL): Record<string, string> | null;
  handle: RouteHandler;
}

/** Exact-path route; matches only the listed method(s). */
export function route(
  method: string | string[],
  pathname: string,
  handle: RouteHandler,
): Route {
  const methods = Array.isArray(method) ? method : [method];
  return {
    match(requestMethod, url) {
      if (!methods.includes(requestMethod)) return null;
      return url.pathname === pathname ? {} : null;
    },
    handle,
  };
}

/**
 * Pattern route matched on pathname only — method handling lives in the
 * handler (mirrors the original regex blocks that return their own 405).
 * Capture groups are exposed as params under the supplied names.
 */
export function patternRoute(
  pattern: RegExp,
  paramNames: string[],
  handle: RouteHandler,
): Route {
  return {
    match(_method, url) {
      const matched = pattern.exec(url.pathname);
      if (!matched) return null;
      const params: Record<string, string> = {};
      matched.slice(1).forEach((value, index) => {
        params[paramNames[index] ?? String(index)] = value;
      });
      return params;
    },
    handle,
  };
}

/** Prefix route (e.g. `/assets/*`), method-filtered. */
export function prefixRoute(
  method: string | string[],
  prefix: string,
  handle: RouteHandler,
): Route {
  const methods = Array.isArray(method) ? method : [method];
  return {
    match(requestMethod, url) {
      if (!methods.includes(requestMethod)) return null;
      return url.pathname.startsWith(prefix) ? {} : null;
    },
    handle,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
