/** Errors API entry point shared by browser and desktop. */
import type { ErrorsApi } from "./errors-api.js";
import { httpErrorsApi } from "./errors-http.js";

const api: ErrorsApi = httpErrorsApi;

export const { getErrorIncidents, getErrorPrompt, getErrorBundle, startFix } = api;

export type {
  ErrorsApi,
  IncidentLevel,
  ErrorIncident,
  ErrorIncidentPrompt,
  ErrorReproBundle,
  FixPreparation,
} from "./errors-api.js";
