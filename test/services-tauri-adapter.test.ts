import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerService: vi.fn(),
}));

vi.mock("../src/web/client/src/lib/api/tauri-bridge", () => ({
  tauri_getDashboard: vi.fn(),
  tauri_getServiceDefinition: vi.fn(),
  tauri_startService: vi.fn(),
  tauri_stopService: vi.fn(),
  tauri_restartService: vi.fn(),
  tauri_startBundle: vi.fn(),
  tauri_stopBundle: vi.fn(),
  tauri_deleteService: vi.fn(),
  tauri_registerService: mocks.registerService,
  tauri_registerBundle: vi.fn(),
  tauri_getServiceLogs: vi.fn(),
}));

import { tauriServicesApi } from "../src/web/client/src/lib/api/services-tauri";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registerService.mockResolvedValue({ ok: true });
});

describe("Tauri services adapter", () => {
  test("preserves direct arguments and environment values when saving", async () => {
    const service = {
      name: "worker",
      kind: "local" as const,
      command: "node",
      args: [],
      cwd: "/repo",
      env: { API_TOKEN: "private" },
    };

    await tauriServicesApi.registerService(service);

    expect(mocks.registerService).toHaveBeenCalledWith(service);
  });
});
