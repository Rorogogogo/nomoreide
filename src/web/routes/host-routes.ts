import type { ServerResponse } from "node:http";
import { invalidateHostSshTargets } from "../../core/providers/host-bridge.js";
import {
  providerCliStatus,
  publicProviderConnection,
} from "../../core/providers/credentials.js";
import {
  hostProviderManifests,
  requireHostActions,
  requireHostContext,
  requireHostProvider,
} from "../../core/providers/registry.js";
import { readForm, requiredFormValue, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/**
 * Host-provider visibility and controls, for every registered host provider.
 *
 * Nothing below names a provider: the id is a path segment, the client comes
 * from the registry, and which actions exist comes from the provider's
 * manifest. Adding DigitalOcean adds no route.
 *
 * Separate from `provider-routes.ts` rather than merged with it, because the
 * two contracts disagree about almost every path: a deploy route is scoped to
 * the selected repository's project, a host route is scoped to nothing but the
 * account. The one thing they genuinely share — connecting a credential — is
 * ~20 lines of form handling, and pulling that into a shared helper would have
 * coupled the two route families to save less than it cost.
 *
 * Reads go through the read-safe `HostProvider`; power operations are funnelled
 * through the single `POST /api/hosts/:id/instances/:instance/:action` route
 * below, so the write boundary has exactly one door.
 *
 * The instances themselves also reach the user through `GET /api/servers`,
 * which is the point of the contract — see `providers/host-bridge.ts`.
 */

function methodNotAllowed(response: ServerResponse): void {
  sendJson(response, { ok: false, error: "Method not allowed" }, 405);
}

/** `/api/hosts/:id/<suffix>`, with the id captured. */
function hostRoute(suffix: string, handle: Route["handle"]): Route {
  return patternRoute(
    new RegExp(`^/api/hosts/([^/]+)/${suffix}$`),
    ["provider", ...captureNames(suffix)],
    handle,
  );
}

/** Names for the capture groups a suffix declares, in order. */
function captureNames(suffix: string): string[] {
  return [...suffix.matchAll(/\(\?<(\w+)>/g)].map((match) => match[1]);
}

export const hostRoutes: Route[] = [
  /** The registry itself — what the dashboard renders a tab for. */
  route("GET", "/api/hosts", async ({ response }) => {
    sendJson(response, { ok: true, providers: hostProviderManifests() });
  }),

  hostRoute("status", async ({ response, params, configStore }) => {
    try {
      const provider = requireHostProvider(params.provider);
      const config = await configStore.load();
      const cli = await providerCliStatus(provider.auth);
      const connection = config.connections[provider.manifest.id];
      const base = {
        ok: true,
        provider: provider.manifest,
        connection: publicProviderConnection(connection),
        cliAvailable: cli.available,
        cliError: cli.error,
      };

      if (!connection && !cli.available) {
        sendJson(response, { ...base, status: "not_configured" });
        return;
      }

      try {
        const context = await provider.context(configStore);
        const account = await context.provider.account();
        sendJson(response, {
          ...base,
          // An ambient credential is enough to work: a user who never opened
          // this tab still gets a connected dashboard rather than a setup screen.
          connection: base.connection ?? { source: "cli" as const },
          status: "connected",
          user: { username: account.username, avatar: account.avatar ?? undefined },
        });
      } catch (error) {
        sendJson(response, {
          ...base,
          status: isAuthError(error) ? "auth_error" : "connection_error",
          error: errorMessage(error),
        });
      }
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 404);
    }
  }),

  hostRoute("connect", async ({ request, response, params, configStore }) => {
    try {
      const provider = requireHostProvider(params.provider);

      if (request.method === "DELETE") {
        await configStore.removeConnection(provider.manifest.id);
        invalidateHostSshTargets();
        sendJson(response, { ok: true });
        return;
      }
      if (request.method !== "POST") {
        methodNotAllowed(response);
        return;
      }

      const form = await readForm(request);
      if (form.get("source")?.trim() === "cli") {
        const session = await provider.auth.cliSession?.(process.env);
        if (!session) throw new Error(provider.auth.messages.cliMissing);
        await configStore.setConnection(provider.manifest.id, {
          source: "cli",
          scopeId: session.currentScope,
        });
      } else {
        await configStore.setConnection(provider.manifest.id, {
          source: "stored",
          token: requiredFormValue(form, "token"),
        });
      }
      // The servers list is about to show a different set of machines.
      invalidateHostSshTargets();
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  // --- Instances ---

  hostRoute("instances", async ({ request, response, params, configStore }) => {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return;
    }
    try {
      const context = await requireHostContext(params.provider, configStore);
      sendJson(response, { ok: true, instances: await context.provider.listInstances() });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  /**
   * The write boundary's single door. Every power operation arrives here,
   * POST-only and named in the path, so there is one place to audit what a
   * provider can change and one place a guard would go. Which names are legal
   * comes from the manifest, not from this file.
   */
  hostRoute(
    "instances/(?<instance>[^/]+)/(?<action>[^/]+)",
    async ({ request, response, params, configStore }) => {
      if (request.method !== "POST") {
        methodNotAllowed(response);
        return;
      }
      try {
        const provider = requireHostProvider(params.provider);
        if (!provider.manifest.actions.includes(params.action)) {
          sendJson(
            response,
            { ok: false, error: `${provider.manifest.name} has no action "${params.action}".` },
            404,
          );
          return;
        }
        const actions = await requireHostActions(provider.manifest.id, configStore);
        await actions.run(params.action, decodeURIComponent(params.instance));
        // The instance's state just changed, and it is on the servers list.
        invalidateHostSshTargets();
        sendJson(response, { ok: true });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  hostRoute("instances/(?<instance>[^/]+)", async ({ request, response, params, configStore }) => {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return;
    }
    try {
      const context = await requireHostContext(params.provider, configStore);
      sendJson(response, {
        ok: true,
        instance: await context.provider.getInstance(decodeURIComponent(params.instance)),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),
];

/**
 * Auth failures get their own status so the UI offers reconnect rather than
 * retry. Duck-typed on `status` because the error class belongs to whichever
 * provider raised it, and this file must not know their names.
 */
function isAuthError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 401 || status === 403;
}
