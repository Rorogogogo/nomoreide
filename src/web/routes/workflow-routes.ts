import { listWorkflows, workflowSchema } from "../../core/workflows.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/**
 * User-owned git/GitHub workflows. `GET` returns the built-in templates merged
 * with the user's saved/forked workflows; `POST`/`DELETE` persist edits through
 * ConfigStore. The runner lives client-side and executes agent steps as fresh
 * headless tasks, so there's no "run" endpoint here.
 */
export const workflowRoutes: Route[] = [
  route("GET", "/api/workflows", async ({ response, configStore }) => {
    try {
      const config = await configStore.load();
      sendJson(response, { ok: true, workflows: listWorkflows(config.workflows) });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/workflows", async ({ request, response, configStore }) => {
    try {
      const body = await readJson(request);
      const workflow = workflowSchema.parse({ ...body, builtin: false });
      const config = await configStore.saveWorkflow(workflow);
      sendJson(response, { ok: true, workflows: listWorkflows(config.workflows) });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/workflows\/([^/]+)$/,
    ["id"],
    async ({ request, response, configStore, params }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const config = await configStore.removeWorkflow(decodeURIComponent(params.id));
        sendJson(response, { ok: true, workflows: listWorkflows(config.workflows) });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),
];
