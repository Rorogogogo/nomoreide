/**
 * Rust-core implementation of {@link ErrorsApi} (desktop). Error tracking has no
 * Rust backend: the incident list degrades to empty, and the prompt/bundle
 * helpers are inherited from the HTTP impl (unused in desktop, where no incident
 * is ever surfaced to act on).
 */
import { httpErrorsApi } from "./errors-http.js";
import type { ErrorsApi } from "./errors-api.js";

export const tauriErrorsApi: ErrorsApi = {
  ...httpErrorsApi,
  getErrorIncidents: async () => [],
};
