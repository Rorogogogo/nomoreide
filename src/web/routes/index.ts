import type { Route } from "./context.js";
import { dashboardRoutes } from "./dashboard-routes.js";
import { agentRoutes } from "./agent-routes.js";
import { agentChatRoutes } from "./agent-chat-routes.js";
import { databaseRoutes } from "./database-routes.js";
import { errorRoutes } from "./errors-routes.js";
import { gitRoutes } from "./git-routes.js";
import { githubRoutes } from "./github-routes.js";
import { logSourceRoutes } from "./log-sources-routes.js";
import { metricsRoutes } from "./metrics-routes.js";
import { onboardRoutes } from "./onboard-routes.js";
import { serviceRoutes } from "./service-routes.js";
import { shellRoutes } from "./shell-routes.js";
import { snapshotRoutes } from "./snapshot-routes.js";
import { terminalRoutes } from "./terminal-routes.js";
import { workflowRoutes } from "./workflow-routes.js";
import { workflowTriggerRoutes } from "./workflow-trigger-routes.js";

/**
 * All routes in dispatch order. `/api/*` route groups come first; the shell /
 * static catch-alls are last so they only run when no API route matched.
 *
 * To add a feature: create `<feature>-routes.ts` exporting a `Route[]`, then
 * register it here. The dispatcher in `server.ts` never needs to change.
 */
export const routes: Route[] = [
  ...dashboardRoutes,
  ...agentRoutes,
  ...agentChatRoutes,
  ...databaseRoutes,
  ...errorRoutes,
  ...githubRoutes,
  ...gitRoutes,
  ...logSourceRoutes,
  ...metricsRoutes,
  ...workflowRoutes,
  ...workflowTriggerRoutes,
  ...onboardRoutes,
  ...serviceRoutes,
  ...snapshotRoutes,
  ...terminalRoutes,
  ...shellRoutes,
];

export type { Route, RouteServices, RequestContext, RouteHandler } from "./context.js";
