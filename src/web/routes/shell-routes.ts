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
  // "/" is Home; Services has its own path since the Home page took the root.
  "/",
  "/services",
  "/activity",
  "/servers",
  "/docker",
  "/git",
  "/github",
  "/workflows",
  "/agent",
  "/agent-env",
  "/context",
  "/extensions",
  "/errors",
  "/database",
  "/settings",
]);

/**
 * Path prefixes that also serve the shell, for pages whose last segment is
 * *data* rather than a route the client knows in advance.
 *
 * `/extensions/<id>` is the only one: which plugins exist comes from the
 * registry, so an exact-match set could not list them without this file
 * learning their names — exactly what the two-layer nav was built not to need.
 */
export const shellPathPrefixes = ["/extensions/"];

/** Whether a path should serve the SPA shell. */
export function servesShell(pathname: string): boolean {
  if (shellPaths.has(pathname)) return true;
  return shellPathPrefixes.some(
    // A bare prefix with nothing after it is not a page; `/extensions` already
    // is one, and `/extensions/` should not quietly render as the same thing.
    (prefix) => pathname.startsWith(prefix) && pathname.length > prefix.length,
  );
}

/** Static assets and the SPA shell. Registered last so /api/* wins first. */
export const shellRoutes: Route[] = [
  {
    match(method, url) {
      if (method !== "HEAD") return null;
      return servesShell(url.pathname) ? {} : null;
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
      return servesShell(url.pathname) ? {} : null;
    },
    async handle({ response }) {
      sendHtml(response, await readWebAppShell());
    },
  },
];
