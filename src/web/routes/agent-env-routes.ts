import {
  getAgentAvailability,
  readAllAgentConfigs,
  runAgentDoctor,
} from "../../core/agent-env/index.js";
import { sendJson } from "../http-utils.js";
import { errorMessage, route, type Route } from "./context.js";

/**
 * Agent Environments (ROR-60): read-only views of coding agents' live MCP +
 * skill configuration. All three endpoints are read-on-mount — each has a
 * matching handler in `website/src/mock-api.ts`.
 */
export const agentEnvRoutes: Route[] = [
  route("GET", "/api/agent-env/agents", async ({ response }) => {
    try {
      sendJson(response, { ok: true, agents: await getAgentAvailability() });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("GET", "/api/agent-env/live", async ({ response, cwd }) => {
    try {
      sendJson(response, { ok: true, configs: await readAllAgentConfigs({ cwd }) });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("GET", "/api/agent-env/doctor", async ({ response, cwd }) => {
    try {
      const result = await runAgentDoctor({ cwd });
      sendJson(response, { ok: true, ...result });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),
];
