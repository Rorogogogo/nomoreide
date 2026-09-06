import type { AppPage } from "@/components/app-navigation";
import type { TranslationKey } from "@/lib/i18n";

/**
 * Where each page lives in the URL, and how a URL maps back to a page.
 *
 * Kept apart from `app.tsx` because it is the one part of the shell that is
 * deliberately feature-agnostic: adding a page means adding a row to the two
 * maps here, never editing a dispatcher. `test/shell-paths.test.ts` asserts
 * this file and the server's `shell-routes.ts` agree, so a half-done move
 * fails the suite rather than 404ing on refresh.
 */

type Page = AppPage;

/** Client-side route per page. */
export const PAGE_PATHS: Record<Page, string> = {
  /*
    Home owns "/", and Services moved to a path of its own.
    §8.2 of the Home design: a Home that is one more nav row is a page nobody
    lands on, and it would make the sidebar longer without giving anything back.
    `test/shell-paths.test.ts` asserts this map and `shellPaths` agree, so a
    half-done move fails CI rather than 404ing on refresh.
  */
  home: "/",
  services: "/services",
  activity: "/activity",
  remote: "/remote",
  servers: "/servers",
  docker: "/docker",
  git: "/git",
  github: "/github",
  linear: "/linear",
  errors: "/errors",
  database: "/database",
  agent: "/agent",
  "agent-env": "/agent-env",
  context: "/context",
  extensions: "/extensions",
  settings: "/settings",
};

/**
 * One installed plugin's page, the nav's second layer.
 *
 * A child of `/extensions` rather than a page id of its own, because the set of
 * plugins is *data* — `AppPage` is a closed union and a downloaded plugin
 * cannot add a member to it. The id lives beside `page` in state instead, which
 * is what keeps a fourth provider from needing an edit here.
 */
export const EXTENSION_PATH_PREFIX = "/extensions/";

export function extensionPath(id: string): string {
  return `${EXTENSION_PATH_PREFIX}${encodeURIComponent(id)}`;
}

/** The plugin a path addresses, or null when it is not an extension page. */
export function extensionIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(EXTENSION_PATH_PREFIX)) return null;
  const id = decodeURIComponent(pathname.slice(EXTENSION_PATH_PREFIX.length)).trim();
  return id || null;
}

/** Header title translation key per page. */
export const PAGE_TITLE_KEY: Record<Page, TranslationKey> = {
  home: "nav.home",
  services: "nav.services",
  activity: "nav.activity",
  servers: "nav.servers",
  docker: "nav.docker",
  remote: "nav.remote",
  git: "nav.git",
  github: "nav.github",
  linear: "nav.linear",
  errors: "nav.errors",
  database: "nav.database",
  agent: "pageTitle.agent",
  "agent-env": "pageTitle.agentEnv",
  context: "pageTitle.context",
  extensions: "pageTitle.extensions",
  settings: "nav.settings",
};

// Longest prefix wins so "/agent-env" is matched before "/agent".
const PAGE_PATH_MATCHERS = (Object.entries(PAGE_PATHS) as Array<[Page, string]>)
  .filter(([, path]) => path !== "/")
  .sort(([, a], [, b]) => b.length - a.length);

export function pageFromPath(pathname: string): Page {
  // `/extensions/<id>` is the extensions page with a plugin selected, so the
  // prefix has to be checked before the exact matches — otherwise a deep link
  // to a plugin silently lands on Services.
  if (extensionIdFromPath(pathname)) return "extensions";
  for (const [page, path] of PAGE_PATH_MATCHERS) {
    if (pathname === path) return page;
  }
  // "/" and anything unrecognised land on Home, which is what "/" now means.
  return "home";
}

/**
 * The registry's "Open in NoMoreIDE" button links to `/?install=<slug>` (see
 * the platform's public-profile-page.tsx). Returns the slug to install, or null
 * when the param is absent or empty.
 *
 * The value is only ever handed to the install endpoint as a slug, never
 * interpolated into markup or a URL path, so no escaping is needed here —
 * `URLSearchParams` has already decoded it.
 */
export function installSlugFromSearch(search: string): string | null {
  const slug = new URLSearchParams(search).get("install")?.trim();
  return slug ? slug : null;
}

/**
 * Page to open on first paint. A registry deep link lands on "/" — which would
 * otherwise route to Home — but means "go install this", so the install param
 * outranks the path.
 */
export function initialPage(location: { pathname: string; search: string }): Page {
  if (installSlugFromSearch(location.search)) return "agent-env";
  return pageFromPath(location.pathname);
}

