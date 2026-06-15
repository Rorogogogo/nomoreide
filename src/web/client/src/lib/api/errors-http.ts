/** Node HTTP-server implementation of {@link ErrorsApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  ErrorIncident,
  ErrorIncidentPrompt,
  ErrorReproBundle,
  ErrorsApi,
} from "./errors-api.js";

export const httpErrorsApi: ErrorsApi = {
  async getErrorIncidents(limit = 100) {
    const response = await requestJson<{ ok: true; incidents: ErrorIncident[] }>(
      `/api/errors?limit=${limit}`,
    );
    return response.incidents;
  },

  getErrorPrompt(id) {
    return requestJson<{ ok: true } & ErrorIncidentPrompt>(`/api/errors/${id}/prompt`);
  },

  getErrorBundle(id, save = false) {
    const query = save ? "?save=1" : "";
    return requestJson<{ ok: true } & ErrorReproBundle>(`/api/errors/${id}/bundle${query}`);
  },
};
