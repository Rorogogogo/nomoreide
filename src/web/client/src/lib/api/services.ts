/**
 * Services API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as the
 * named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch. The bundle-membership helpers below compose the
 * transport-agnostic `registerBundle` primitive so their array logic is not
 * duplicated across backends.
 */
import { isTauri } from "./tauri-bridge.js";
import type { ServicesApi } from "./services-api.js";
import { httpServicesApi } from "./services-http.js";
import { tauriServicesApi } from "./services-tauri.js";

const api: ServicesApi = isTauri() ? tauriServicesApi : httpServicesApi;

export const {
  getDashboard,
  startService,
  stopService,
  restartService,
  startBundle,
  stopBundle,
  deleteService,
  getServiceLogs,
  getDirectories,
  browseServiceConfig,
  getServiceConfigFiles,
  getServiceConfigFile,
  putServiceConfigFileEnv,
  putServiceConfigFileText,
  getServiceMetrics,
  testServiceCommand,
  runServiceTests,
} = api;

/** Add a service to a bundle, preserving its other members. */
export async function addServiceToBundle(
  bundleName: string,
  bundleServices: string[],
  serviceName: string,
): Promise<void> {
  if (bundleServices.includes(serviceName)) return;
  await api.registerBundle({ name: bundleName, services: [...bundleServices, serviceName] });
}

/** Remove a service from a bundle, leaving the rest of the group intact. */
export async function removeServiceFromBundle(
  bundleName: string,
  bundleServices: string[],
  serviceName: string,
): Promise<void> {
  if (!bundleServices.includes(serviceName)) return;
  await api.registerBundle({
    name: bundleName,
    services: bundleServices.filter((service) => service !== serviceName),
  });
}

export type {
  ServicesApi,
  ServiceKind,
  ServiceDefinition,
  BundleDefinition,
  GitRepositoryDefinition,
  ServiceStatus,
  InspectorStatus,
  ProcessTreeSummary,
  ProcessRow,
  PortOverview,
  HostPortStatus,
  LogEntry,
  ServiceHealth,
  HealthCheckResult,
  TimelineEvent,
  ServiceTestResult,
  DirectoryEntry,
  DirectoryListing,
  DashboardData,
  ServiceLogsResult,
  ConfigFileFormat,
  ConfigFileInfo,
  ServiceEnvEntry,
  ConfigFileEnvResponse,
  ConfigFileTextResponse,
  ConfigFileResponse,
  ConfigBrowseEntry,
  ConfigBrowseResult,
  MetricSample,
  MetricsSeries,
  TestRunStatus,
  TestRun,
  TestRunEvent,
} from "./services-api.js";
