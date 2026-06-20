/**
 * Services API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as the
 * named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch. The bundle-membership helpers below compose the
 * transport-agnostic `registerBundle` primitive so their array logic is not
 * duplicated across backends.
 */
import { isTauri } from "./tauri-bridge.js";
import type { DashboardData, ServiceGraph, ServicesApi } from "./services-api.js";
import { httpServicesApi } from "./services-http.js";
import { tauriServicesApi } from "./services-tauri.js";

const api: ServicesApi = isTauri() ? tauriServicesApi : httpServicesApi;

export const {
  getDashboard,
  getServiceGraph,
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

/**
 * Start a bundle service-by-service so the UI updates progressively instead of
 * jumping straight to "all running" when the one-shot {@link startBundle} call
 * returns. Resolves the bundle's dependency order client-side from the graph
 * (deps before dependents, transitive deps pulled in), starts each service in
 * turn, and calls `onServiceStarted` after each so the caller can refresh.
 * Before a dependent, it waits for each dependency's port to bind (15s cap), so
 * the readiness gating still holds. Falls back to the server's one-shot start if
 * the bundle or graph can't be resolved (and works on both backends, since it
 * only composes transport-agnostic primitives).
 */
export async function startBundleProgressive(
  bundleName: string,
  onServiceStarted?: (name: string) => void | Promise<void>,
): Promise<void> {
  let dashboard: DashboardData;
  let graph: ServiceGraph;
  try {
    dashboard = await api.getDashboard();
    graph = await api.getServiceGraph();
  } catch {
    await api.startBundle(bundleName);
    return;
  }

  const bundle = dashboard.config.bundles.find((item) => item.name === bundleName);
  if (!bundle) {
    await api.startBundle(bundleName);
    return;
  }

  const depsByName = new Map(graph.nodes.map((node) => [node.name, node.dependsOn]));
  const portByName = new Map(
    dashboard.config.services.map((service) => [service.name, service.port]),
  );

  // Expand the bundle to include any transitive deps it declares, then keep the
  // graph's topological order. An empty `graph.order` means a cycle — fall back
  // to declaration order rather than starting nothing.
  const wanted = new Set<string>();
  const stack = [...bundle.services];
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (wanted.has(name) || !depsByName.has(name)) continue;
    wanted.add(name);
    for (const dep of depsByName.get(name) ?? []) stack.push(dep);
  }
  const ordered = graph.order.filter((name) => wanted.has(name));
  const startOrder = ordered.length > 0 ? ordered : bundle.services;

  for (const name of startOrder) {
    for (const dep of depsByName.get(name) ?? []) {
      const port = portByName.get(dep);
      if (port) await waitForPortBound(port);
    }
    await api.startService(name);
    await onServiceStarted?.(name);
  }
}

/** Poll the dashboard until `port` reports bound (occupied), or time out. */
async function waitForPortBound(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const dashboard = await api.getDashboard();
      if (dashboard.ports.some((overview) => overview.port === port && !overview.available)) {
        return;
      }
    } catch {
      return; // can't probe → don't wedge the start
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
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
  ServiceGraph,
  ServiceGraphNode,
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
