/**
 * Errors API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as the
 * named functions the rest of the app already imports. Adding/altering an error
 * endpoint means editing the {@link ErrorsApi} interface plus both implementations
 * — never a per-function `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { ErrorsApi } from "./errors-api.js";
import { httpErrorsApi } from "./errors-http.js";
import { tauriErrorsApi } from "./errors-tauri.js";

const api: ErrorsApi = isTauri() ? tauriErrorsApi : httpErrorsApi;

export const { getErrorIncidents, getErrorPrompt, getErrorBundle } = api;

export type {
  ErrorsApi,
  IncidentLevel,
  ErrorIncident,
  ErrorIncidentPrompt,
  ErrorReproBundle,
} from "./errors-api.js";
