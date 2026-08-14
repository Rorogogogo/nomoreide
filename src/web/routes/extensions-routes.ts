import { listInstalledExtensions } from "../../core/extensions.js";
import { sendJson } from "../http-utils.js";
import { route, type Route } from "./context.js";

/**
 * The Extensions section's data — what is installed.
 *
 * One route, and it will stay small for a while: stage 2 of §12 deliberately
 * ships no install, remove or browse, because every extension is built-in and
 * those controls would be decoration. When the marketplace opens, `POST
 * /api/extensions/install` and `DELETE /api/extensions/:id` join this file
 * rather than the dispatcher.
 *
 * Nothing here names a provider — the rows come from the registries, so a
 * fourth provider appears on the page without this file changing.
 */
export const extensionsRoutes: Route[] = [
  route("GET", "/api/extensions", async ({ response }) => {
    sendJson(response, { ok: true, extensions: listInstalledExtensions() });
  }),
];
