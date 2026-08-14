import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { invalidateHostSshTargets } from "../src/core/providers/host-bridge.js";
import { createWebServer } from "../src/web/server.js";

/**
 * The `HostProvider` half of the registry, over real HTTP.
 *
 * Two things are under test here and only one of them is Vultr. The other is
 * the claim §7 of the design plan makes: that a host provider's instances reach
 * the user through the SSH server list that already exists, rather than through
 * a second list nobody would look at.
 */

let tempDir: string;
let configPath: string;
let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>>;
/** Every Vultr API call the routes made, so paths and methods are assertable. */
let apiCalls: Array<{ url: URL; method: string }>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-host-routes-"));
  configPath = join(tempDir, "nomoreide.config.json");
  apiCalls = [];
  // Instance lists are cached for 30s process-wide; a case must not inherit
  // another's, and a developer's own machines must not leak in either.
  invalidateHostSshTargets();
  // The `cli` source reads the ambient environment, so a real VULTR_API_KEY on
  // the machine running the suite would otherwise reach the live API.
  vi.stubEnv("VULTR_API_KEY", "");
  vi.stubEnv("VULTR_API_TOKEN", "");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  invalidateHostSshTargets();
  await server?.stop();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Intercept Vultr's host only — the server under test also serves its own
 * routes over real HTTP, and those must keep working.
 */
function stubVultrApi(responder: (url: URL, method: string) => unknown): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (!rawUrl.startsWith("https://api.vultr.com")) {
      return realFetch(input as string | URL, init);
    }
    const url = new URL(rawUrl);
    const method = init?.method ?? "GET";
    apiCalls.push({ url, method });
    const payload = responder(url, method);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

async function startServer(): Promise<void> {
  server = await createWebServer({
    configPath,
    settingsPath: join(tempDir, "settings.json"),
    logDir: join(tempDir, "logs"),
    cwd: tempDir,
    registryPath: join(tempDir, "runtime.json"),
    port: 0,
  }).start();
}

async function connectVultr(): Promise<void> {
  await new ConfigStore(configPath).setConnection("vultr", {
    source: "stored",
    token: "vultr-key",
  });
}

const INSTANCE = {
  id: "cb676a46-66fd-4dfb-b839-443f2e6c0b60",
  label: "api-01",
  hostname: "api-01.example.com",
  status: "active",
  power_status: "running",
  server_status: "ok",
  main_ip: "45.32.10.1",
  region: "ewr",
  plan: "vc2-1c-1gb",
  os: "Ubuntu 24.04 LTS x64",
  vcpu_count: 1,
  ram: 1024,
  disk: 25,
  tags: ["api"],
  date_created: "2026-01-02T03:04:05+00:00",
  user_scheme: "root",
};

describe("host provider routes", () => {
  test("the registry lists host providers separately from deploy providers", async () => {
    await startServer();

    const hosts = await (await fetch(`${server.url}/api/hosts`)).json();
    const deploys = await (await fetch(`${server.url}/api/providers`)).json();

    expect(hosts.providers).toEqual([
      {
        id: "vultr",
        name: "Vultr",
        kind: "host",
        actions: ["start", "halt", "reboot"],
        productionAffecting: ["halt", "reboot"],
        api: { hosts: ["api.vultr.com"] },
      },
    ]);
    // Two contracts, two registries: a host provider must never show up where
    // the dashboard expects projects and deployments.
    expect(deploys.providers.map((manifest: { id: string }) => manifest.id)).not.toContain("vultr");
  });

  test("an unknown host provider is a 404 naming the id that was asked for", async () => {
    await startServer();

    const response = await fetch(`${server.url}/api/hosts/hetzner/status`);

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/hetzner/);
  });

  test("reports not_configured before anything is connected", async () => {
    await startServer();

    const body = await (await fetch(`${server.url}/api/hosts/vultr/status`)).json();

    expect(body).toMatchObject({ status: "not_configured", cliAvailable: false });
    expect(body.cliError).toMatch(/VULTR_API_KEY/);
  });

  test("connect stores a key, status reports the account, and disconnect removes it", async () => {
    stubVultrApi(() => ({ account: { name: "Acme", email: "ops@acme.dev", acls: [] } }));
    await startServer();

    await fetch(`${server.url}/api/hosts/vultr/connect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ source: "stored", token: "vultr-key" }),
    });
    const body = await (await fetch(`${server.url}/api/hosts/vultr/status`)).json();

    expect(body).toMatchObject({ status: "connected", user: { username: "ops@acme.dev" } });
    // The status route reports the connection, never its secrets.
    expect(body.connection.token).toBeUndefined();

    await fetch(`${server.url}/api/hosts/vultr/connect`, { method: "DELETE" });
    expect((await new ConfigStore(configPath).load()).connections.vultr).toBeUndefined();
  });

  test("lists instances in the neutral shape, with the vendor's own state word", async () => {
    await connectVultr();
    stubVultrApi(() => ({ instances: [INSTANCE, { ...INSTANCE, id: "i_2", status: "suspended" }] }));
    await startServer();

    const body = await (await fetch(`${server.url}/api/hosts/vultr/instances`)).json();

    expect(body.instances[0]).toMatchObject({
      id: INSTANCE.id,
      label: "api-01",
      state: "running",
      rawState: "running",
      ipv4: "45.32.10.1",
      region: "ewr",
      specs: { vcpus: 1, memoryMb: 1024, diskGb: 25 },
      defaultUser: "root",
    });
    // A locked machine has no neutral state of its own; the word survives.
    expect(body.instances[1]).toMatchObject({ state: "error", rawState: "suspended" });
  });

  test("a power action goes through the one write door, named in the path", async () => {
    await connectVultr();
    stubVultrApi(() => new Response(null, { status: 204 }));
    await startServer();

    const response = await fetch(
      `${server.url}/api/hosts/vultr/instances/${INSTANCE.id}/reboot`,
      { method: "POST" },
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].method).toBe("POST");
    expect(apiCalls[0].url.pathname).toBe(`/v2/instances/${INSTANCE.id}/reboot`);
  });

  test("an action the manifest does not declare never reaches the provider", async () => {
    await connectVultr();
    stubVultrApi(() => ({}));
    await startServer();

    const response = await fetch(
      `${server.url}/api/hosts/vultr/instances/${INSTANCE.id}/destroy`,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/Vultr has no action "destroy"/);
    expect(apiCalls).toEqual([]);
  });

  test("reads are GET-only, so a state change cannot arrive through them", async () => {
    await connectVultr();
    stubVultrApi(() => ({}));
    await startServer();

    const response = await fetch(`${server.url}/api/hosts/vultr/instances`, { method: "POST" });

    expect(response.status).toBe(405);
  });
});

describe("host instances reach the user through the SSH server list", () => {
  test("an instance is adopted as an SSH target with the login Vultr created", async () => {
    await connectVultr();
    stubVultrApi(() => ({ instances: [INSTANCE] }));
    await startServer();

    const body = await (await fetch(`${server.url}/api/servers`)).json();
    const adopted = body.servers.find(
      (entry: { host: string }) => entry.host === "root@45.32.10.1",
    );

    expect(adopted).toMatchObject({
      host: "root@45.32.10.1",
      name: "api-01",
      // Neither saved by the user nor found in ~/.ssh/config — the third source.
      saved: false,
      discovered: false,
      instance: {
        providerId: "vultr",
        providerName: "Vultr",
        instanceId: INSTANCE.id,
        state: "running",
        rawState: "running",
        region: "ewr",
      },
    });
  });

  test("the user's own metadata wins over the provider's", async () => {
    await connectVultr();
    await new ConfigStore(configPath).registerSshServer({
      host: "root@45.32.10.1",
      name: "Production API",
      environment: "Production",
    });
    stubVultrApi(() => ({ instances: [INSTANCE] }));
    await startServer();

    const body = await (await fetch(`${server.url}/api/servers`)).json();
    const rows = body.servers.filter(
      (entry: { host: string }) => entry.host === "root@45.32.10.1",
    );

    // One row, not two: the provider supplies a starting point, not an override.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Production API",
      environment: "Production",
      saved: true,
      instance: { providerId: "vultr" },
    });
  });

  test("a machine still being provisioned is not listed as a host", async () => {
    await connectVultr();
    stubVultrApi(() => ({
      instances: [{ ...INSTANCE, status: "pending", main_ip: "0.0.0.0", v6_main_ip: "" }],
    }));
    await startServer();

    const body = await (await fetch(`${server.url}/api/servers`)).json();

    // Filtered rather than compared whole: `~/.ssh/config` belongs to whoever
    // is running the suite, and its hosts legitimately appear here too.
    expect(body.servers.filter((entry: { instance?: unknown }) => entry.instance)).toEqual([]);
  });

  test("a provider outage never blanks the servers page", async () => {
    await connectVultr();
    await new ConfigStore(configPath).registerSshServer({ host: "prod-web", name: "Prod" });
    stubVultrApi(() => new Response("gateway timeout", { status: 504 }));
    await startServer();

    const body = await (await fetch(`${server.url}/api/servers`)).json();

    // The user's own hosts still list; there is nowhere in this page's shape to
    // report a vendor outage, and going blank would be the worse answer.
    expect(body.ok).toBe(true);
    expect(body.servers).toContainEqual({
      host: "prod-web",
      name: "Prod",
      discovered: false,
      saved: true,
    });
    expect(body.servers.filter((entry: { instance?: unknown }) => entry.instance)).toEqual([]);
  });

  test("nothing is asked of a provider the user has not connected", async () => {
    stubVultrApi(() => ({ instances: [INSTANCE] }));
    await startServer();

    await fetch(`${server.url}/api/servers`);

    // Credential resolution fails locally, so an unconnected provider costs no
    // request at all — which is what keeps this route as fast as it was.
    expect(apiCalls).toEqual([]);
  });
});
