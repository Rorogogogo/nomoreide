import {
  buildProjectOverview,
  type OverviewDomain,
} from "../../core/project-overview.js";
import { sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, type Route } from "./context.js";

/**
 * The all-projects lens: one summary row per registered project, for a page
 * that would otherwise only ever show the selected one.
 *
 * Read on mount whenever the project scope is "all", so mirrored in
 * `website/src/mock-api.ts`.
 */

const DOMAINS = new Set<OverviewDomain>(["git", "github", "vercel"]);

export const overviewRoutes: Route[] = [
  patternRoute(
    /^\/api\/overview\/([^/]+)$/,
    ["domain"],
    async ({ request, response, configStore, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const domain = params.domain as OverviewDomain;
      if (!DOMAINS.has(domain)) {
        sendJson(response, { ok: false, error: `Unknown overview domain: ${domain}` }, 404);
        return;
      }
      try {
        sendJson(response, {
          ok: true,
          // A per-project failure rides on that project's row, so this only
          // rejects when the config itself could not be read.
          projects: await buildProjectOverview(configStore, domain),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),
];
