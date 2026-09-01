// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import { getAgentEnvAgents } from "../apps/dashboard/src/lib/api/agent-env";

afterEach(() => {
  delete window.__NOMOREIDE_DESKTOP__;
  vi.unstubAllGlobals();
});

describe("desktop agent environment API seam", () => {
  test("uses the authenticated HTTP implementation and exposes the native agent readers", async () => {
    window.__NOMOREIDE_DESKTOP__ = {
      apiBaseUrl: "http://127.0.0.1:54321",
      credential: "desktop-secret",
    };
    const agents = [
      { agent: "cursor", command: "cursor", installed: true },
      { agent: "windsurf", command: "windsurf", installed: true },
    ];
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, agents }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(getAgentEnvAgents()).resolves.toEqual(agents);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:54321/api/agent-env/agents");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer desktop-secret",
    );
  });
});
