/**
 * Onboard API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as the
 * named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { OnboardApi } from "./onboard-api.js";
import { httpOnboardApi } from "./onboard-http.js";
import { tauriOnboardApi } from "./onboard-tauri.js";

const api: OnboardApi = isTauri() ? tauriOnboardApi : httpOnboardApi;

export const { scanRepo, registerOnboarded, streamInstall } = api;

export type {
  OnboardApi,
  OnboardConfidence,
  OnboardProposal,
  OnboardProfile,
  OnboardDatabaseProposal,
  OnboardScanResult,
  InstallStreamHandlers,
} from "./onboard-api.js";
