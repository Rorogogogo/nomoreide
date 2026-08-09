import {
  discoverSshHosts,
  mergeSshServers,
  probeSshServer,
  readRemoteHostMetrics,
} from "../../core/ssh-servers.js";
import type { SshServerDefinition } from "../../core/types.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/** Saved/discovered SSH servers, connection checks, and read-only Linux metrics. */
export const sshServerRoutes: Route[] = [
  route("GET", "/api/servers", async ({ response, configStore }) => {
    const [config, discovered] = await Promise.all([
      configStore.load(),
      discoverSshHosts(),
    ]);
    sendJson(response, {
      ok: true,
      servers: mergeSshServers(config.sshServers, discovered),
    });
  }),

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
      const [config, discovered] = await Promise.all([
        configStore.load(),
        discoverSshHosts(),
      ]);
      const server = mergeSshServers(config.sshServers, discovered).find(
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
