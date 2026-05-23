import { buildDashboardPayload } from "../dashboard.js";
import { listDirectories } from "../directories.js";
import { sendJson } from "../http-utils.js";
import { route, type Route } from "./context.js";

/** Overview / system endpoints: dashboard, health, status, directory browse. */
export const dashboardRoutes: Route[] = [
  route("GET", "/api/dashboard", async ({ response, configStore, cwd, logStore, manager, timelineStore }) => {
    sendJson(
      response,
      await buildDashboardPayload({ configStore, cwd, logStore, manager, timelineStore }),
    );
  }),

  route("GET", "/api/health", ({ response }) => {
    sendJson(response, { ok: true, app: "nomoreide" });
  }),

  route("GET", "/api/status", ({ response, manager }) => {
    sendJson(response, { ok: true, status: manager.status() });
  }),

  route("GET", "/api/fs/directories", async ({ response, url, cwd }) => {
    sendJson(response, await listDirectories(url.searchParams.get("path")?.trim() || cwd));
  }),
];
