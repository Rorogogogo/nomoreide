import { afterEach, expect, test, vi } from "vitest";
import { httpSettingsApi } from "../src/web/client/src/lib/api/settings-http";

const snapshot = {
  ok: true as const,
  global: {
    version: 1 as const,
    terminal: {
      fontSize: 13,
      cursorStyle: "block" as const,
      scrollback: 5_000,
      copyOnSelect: false,
      confirmTerminate: true,
    },
  },
  project: {
    logs: { showTimestamps: true, wrapLines: true },
    database: { confirmWrites: true, resultLimit: 100 },
  },
};

afterEach(() => vi.unstubAllGlobals());

test("encodes the project path for scoped reads, writes, and resets", async () => {
  const fetch = vi.fn(async (url: string) =>
    new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const path = "/work/alpha beta?branch=main";

  await httpSettingsApi.getSettings(path);
  await httpSettingsApi.updateProjectSettings(path, { logs: { wrapLines: false } });
  await httpSettingsApi.resetProjectSettings(path);

  const encoded = encodeURIComponent(path);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `/api/settings?projectPath=${encoded}`,
    `/api/settings/project?projectPath=${encoded}`,
    `/api/settings/project/reset?projectPath=${encoded}`,
  ]);
});

test("keeps the initial settings read unscoped", async () => {
  const fetch = vi.fn(async () =>
    new Response(JSON.stringify(snapshot), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);

  await httpSettingsApi.getSettings();

  expect(fetch).toHaveBeenCalledWith("/api/settings", undefined);
});
