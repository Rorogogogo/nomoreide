import { hostProviderSshTargets } from "../../core/providers/host-bridge.js";
import {
  discoverSshHosts,
  mergeSshServers,
  probeSshServer,
  readRemoteDirectory,
  readRemoteFile,
  readRemoteHostMetrics,
} from "../../core/ssh-servers.js";
import {
  inspectSshSetup,
  resolveSshSetupTerminal,
  type SshSetupAction,
} from "../../core/ssh-setup.js";
import type { SshServerDefinition } from "../../core/types.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/**
 * Saved/discovered SSH servers, connection checks, and read-only Linux metrics.
 *
 * "Discovered" now has a third source: any host provider the user has connected
 * contributes its instances as SSH targets, so a Vultr machine is probed,
 * measured and opened in a terminal by the same routes as a `~/.ssh/config`
 * alias. Nothing below knows which provider — see `providers/host-bridge.ts`.
 */
export const sshServerRoutes: Route[] = [
  route("GET", "/api/servers", async ({ response, configStore }) => {
    const [config, discovered, hostTargets] = await Promise.all([
      configStore.load(),
      discoverSshHosts(),
      hostProviderSshTargets(configStore),
    ]);
    sendJson(response, {
      ok: true,
      servers: mergeSshServers(config.sshServers, discovered, hostTargets),
    });
  }),

  route("GET", "/api/servers/setup/status", async ({ response }) => {
    sendJson(response, { ok: true, setup: await inspectSshSetup() });
  }),

  route(
    "POST",
    "/api/servers/setup/terminal",
    async ({ request, response, terminalManager }) => {
      const body = await readJson(request);
      const action = body.action;
      if (action !== "generate-key" && action !== "install-key") {
        sendJson(response, { ok: false, error: "Unknown SSH setup action." }, 400);
        return;
      }
      try {
        const options = resolveSshSetupTerminal(
          action as SshSetupAction,
          typeof body.host === "string" ? body.host : undefined,
        );
        const session = terminalManager.create({}, options);
        sendJson(response, { ok: true, session }, 201);
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  route("POST", "/api/servers", async ({ request, response, configStore }) => {
    const body = await readJson(request);
    const definition: SshServerDefinition = {
      host: typeof body.host === "string" ? body.host : "",
      name: typeof body.name === "string" && body.name.trim() ? body.name : undefined,
      environment:
        typeof body.environment === "string" && body.environment.trim()
          ? body.environment
          : undefined,
    };
    try {
      const config = await configStore.registerSshServer(definition);
      sendJson(response, { ok: true, servers: config.sshServers });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/servers\/([^/]+)$/,
    ["host"],
    async ({ request, response, params, configStore }) => {
      const host = decodeURIComponent(params.host);
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const config = await configStore.removeSshServer(host);
        sendJson(response, { ok: true, servers: config.sshServers });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/servers\/([^/]+)\/files$/,
    ["host"],
    async ({ request, response, params, url }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const path = url.searchParams.get("path") || ".";
        const directory = await readRemoteDirectory(
          decodeURIComponent(params.host),
          path,
          url.searchParams.get("hidden") === "1",
        );
        sendJson(response, { ok: true, directory });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 502);
      }
    },
  ),

  patternRoute(
    /^\/api\/servers\/([^/]+)\/file$/,
    ["host"],
    async ({ request, response, params, url }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const path = url.searchParams.get("path");
      if (!path) {
        sendJson(response, { ok: false, error: "path is required" }, 400);
        return;
      }
      try {
        const file = await readRemoteFile(decodeURIComponent(params.host), path);
        sendJson(response, { ok: true, file });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 502);
      }
    },
  ),

  patternRoute(
    /^\/api\/servers\/([^/]+)\/probe$/,
    ["host"],
    async ({ request, response, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        sendJson(response, {
          ok: true,
          probe: await probeSshServer(decodeURIComponent(params.host)),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/servers\/([^/]+)\/metrics$/,
    ["host"],
    async ({ request, response, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        sendJson(response, {
          ok: true,
          metrics: await readRemoteHostMetrics(decodeURIComponent(params.host)),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 502);
      }
    },
  ),

  patternRoute(
    /^\/api\/servers\/([^/]+)\/terminal$/,
    ["host"],
    async ({ request, response, params, configStore, terminalManager }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const host = decodeURIComponent(params.host);
      const [config, discovered, hostTargets] = await Promise.all([
        configStore.load(),
        discoverSshHosts(),
        hostProviderSshTargets(configStore),
      ]);
      const server = mergeSshServers(config.sshServers, discovered, hostTargets).find(
        (entry) => entry.host === host,
      );
      if (!server) {
        sendJson(response, { ok: false, error: `Unknown SSH server: ${host}` }, 404);
        return;
      }
      const session = terminalManager.createWithId(`ssh:${host}`, {
        shell: "ssh",
        args: ["-t", host],
        kind: "shell",
        label: server.name ?? host,
      });
      sendJson(response, { ok: true, session }, 201);
    },
  ),
];
