/** Onboarding API entry point shared by browser and desktop. */
import type { OnboardApi } from "./onboard-api.js";
import { httpOnboardApi } from "./onboard-http.js";

const api: OnboardApi = httpOnboardApi;

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
