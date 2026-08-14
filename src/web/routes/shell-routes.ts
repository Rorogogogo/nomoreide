import { sendHead, sendHtml } from "../http-utils.js";
import { readWebAppShell, sendStaticAsset } from "../static-assets.js";
import { prefixRoute, type Route } from "./context.js";

/**
 * Paths that serve the SPA shell (client-side routing handles the rest).
 *
 * Must stay in sync with `PAGE_PATHS` in the client's `app.tsx` — a page the
 * client routes to but this set omits works when navigated to in-app and 404s
 * on direct load or refresh. `test/shell-paths.test.ts` asserts the parity.
 */
export const shellPaths = new Set([
  "/",
  "/activity",
  "/servers",
  "/docker",
  "/git",
  "/github",
  "/deploy",
  "/workflows",
  "/agent",
  "/agent-env",
  "/context",
  "/errors",
  "/database",
  "/terminal",
  "/settings",
]);

/** Static assets and the SPA shell. Registered last so /api/* wins first. */
export const shellRoutes: Route[] = [
  {
    match(method, url) {
      if (method !== "HEAD") return null;
      return shellPaths.has(url.pathname) ? {} : null;
    },
    handle({ response }) {
      sendHead(response, "text/html; charset=utf-8");
    },
  },

  prefixRoute("GET", "/assets/", async ({ response, url }) => {
    if (await sendStaticAsset(response, url.pathname)) return;
    sendHtml(response, "Not found", 404);
  }),

  {
    match(method, url) {
      if (method !== "GET") return null;
      return shellPaths.has(url.pathname) ? {} : null;
    },
    async handle({ response }) {
      sendHtml(response, await readWebAppShell());
    },
  },
];
