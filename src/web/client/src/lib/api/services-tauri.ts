/**
 * Rust-core implementation of {@link ServicesApi}, over Tauri `invoke()` (desktop).
 * Inherits the HTTP impl for the config-file / metrics / test endpoints that have
 * no Rust backend, and overrides the service/bundle lifecycle methods.
 */
import {
  tauri_getDashboard,
  tauri_startService,
  tauri_stopService,
  tauri_restartService,
  tauri_startBundle,
  tauri_stopBundle,
  tauri_deleteService,
  tauri_registerBundle,
  tauri_getServiceLogs,
} from "./tauri-bridge.js";
import { httpServicesApi } from "./services-http.js";
import type { DashboardData, ServiceLogsResult, ServicesApi } from "./services-api.js";

export const tauriServicesApi: ServicesApi = {
  ...httpServicesApi,
  getDashboard: () => tauri_getDashboard() as Promise<DashboardData>,
  startService: (name) => tauri_startService(name),
  stopService: (name) => tauri_stopService(name),
  restartService: (name) => tauri_restartService(name),
  startBundle: (name) => tauri_startBundle(name),
  stopBundle: (name) => tauri_stopBundle(name),
  deleteService: (name) => tauri_deleteService(name),
  registerBundle: (bundle) => tauri_registerBundle(bundle).then(() => undefined),
  getServiceLogs: (name, query = {}) =>
    tauri_getServiceLogs(name, query.lines) as Promise<ServiceLogsResult>,
};
