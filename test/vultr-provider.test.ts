import { afterEach, describe, expect, test, vi } from "vitest";
import { VULTR_AUTH, readVultrEnvSession } from "../src/core/vultr-auth.js";
import { VultrActions } from "../src/core/vultr-actions.js";
import { VultrApiError, VultrManager, type VultrInstance } from "../src/core/vultr-manager.js";
import {
  createVultrHostActions,
  createVultrHostProvider,
  toDefaultUser,
  toHostInstance,
  toInstanceState,
  toRawState,
  toVultrSshTarget,
  VULTR_MANIFEST,
} from "../src/core/vultr-provider.js";

/**
 * Vultr driven through the `HostProvider` contract — implementation #1 of the
 * *second* contract, and therefore the evidence about whether that contract was
 * shaped by the problem or by Vultr.
 *
 * Each block below names the decision it is defending. If one silently reverts,
 * provider #4 pays for it rather than a test failing here.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Records every outgoing request so paths, methods and pagination are assertable. */
function stubFetch(
  responder: (url: URL, init: RequestInit | undefined) => unknown,
): { calls: Array<{ url: URL; init: RequestInit | undefined }> } {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const body = responder(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

/** A Vultr instance as the API sends it, before normalization. */
const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "cb676a46-66fd-4dfb-b839-443f2e6c0b60",
  label: "api-01",
  hostname: "api-01.example.com",
  status: "active",
  power_status: "running",
  server_status: "ok",
  main_ip: "45.32.10.1",
  v6_main_ip: "2001:db8::1",
  region: "ewr",
  plan: "vc2-1c-1gb",
  os: "Ubuntu 24.04 LTS x64",
  vcpu_count: 1,
  ram: 1024,
  disk: 25,
  tags: ["api"],
  date_created: "2026-01-02T03:04:05+00:00",
  user_scheme: "root",
  ...overrides,
});

/** The already-normalized shape, for the pure mappers. */
const instance = (overrides: Partial<VultrInstance> = {}): VultrInstance => ({
  id: "i_1",
  label: "api-01",
  hostname: "api-01.example.com",
  status: "active",
  powerStatus: "running",
  serverStatus: "ok",
  mainIp: "45.32.10.1",
  region: "ewr",
  plan: "vc2-1c-1gb",
  os: "Ubuntu 24.04 LTS x64",
  vcpuCount: 1,
  ramMb: 1024,
  diskGb: 25,
  tags: [],
  userScheme: "root",
  ...overrides,
});

describe("the manifest declares Vultr's own vocabulary", () => {
  test("actions are Vultr's words, and only the disruptive ones need confirming", () => {
    expect(VULTR_MANIFEST).toMatchObject({
      id: "vultr",
      kind: "host",
      actions: ["start", "halt", "reboot"],
      // Starting a stopped machine disturbs nobody; the other two cut power.
      productionAffecting: ["halt", "reboot"],
    });
  });

  test("destructive operations are absent from the contract entirely", () => {
    // Delete and reinstall are unrecoverable, and belong behind their own
    // guarded surface if they ever land — the line `GitManager` draws.
    expect(VULTR_MANIFEST.actions).not.toContain("delete");
    expect(VULTR_MANIFEST.actions).not.toContain("reinstall");
  });
});

describe("state normalization keeps the vendor's own word", () => {
  test("a machine is only running once it is active, powered on, and installed", () => {
    expect(toInstanceState(instance())).toBe("running");
    expect(toInstanceState(instance({ powerStatus: "stopped" }))).toBe("stopped");
    expect(toInstanceState(instance({ serverStatus: "installingbooting" }))).toBe("provisioning");
  });

  test("the subscription lifecycle outranks the power state", () => {
    expect(toInstanceState(instance({ status: "pending", powerStatus: "" }))).toBe("provisioning");
    expect(toInstanceState(instance({ status: "resizing" }))).toBe("provisioning");
    // Suspension is Vultr locking the machine — something the user must act on,
    // which is what `error` means to the UI.
    expect(toInstanceState(instance({ status: "suspended" }))).toBe("error");
  });

  test("rawState carries the word Vultr's own dashboard shows", () => {
    expect(toRawState(instance())).toBe("running");
    expect(toRawState(instance({ powerStatus: "stopped" }))).toBe("stopped");
    expect(toRawState(instance({ serverStatus: "installingbooting" }))).toBe("installing");
    // `suspended` has no neutral equivalent; this is the pressure valve that
    // stops the first badly-mapping provider from forcing a contract change.
    expect(toRawState(instance({ status: "suspended" }))).toBe("suspended");
  });
});

describe("toSshTarget — the payoff the contract exists for", () => {
  test("an instance becomes a plain SSH definition, addressed as its own login", () => {
    expect(toVultrSshTarget(toHostInstance(instance()))).toEqual({
      host: "root@45.32.10.1",
      name: "api-01",
      instance: {
        providerId: "vultr",
        providerName: "Vultr",
        instanceId: "i_1",
        state: "running",
        rawState: "running",
        region: "ewr",
      },
    });
  });

  test("Vultr's limited user scheme is the unprivileged account it really creates", () => {
    expect(toDefaultUser(instance({ userScheme: "limited" }))).toBe("linuxuser");
    expect(toVultrSshTarget(toHostInstance(instance({ userScheme: "limited" })))?.host).toBe(
      "linuxuser@45.32.10.1",
    );
  });

  test("a machine with no address yet is not a target", () => {
    // Still provisioning: there is nothing to connect to, and inventing a
    // placeholder host would list a row that can only ever fail.
    expect(
      toVultrSshTarget(
        toHostInstance(instance({ status: "pending", mainIp: undefined, v6MainIp: undefined })),
      ),
    ).toBeNull();
  });

  test("a stopped machine keeps its target, because that is how you notice it is down", () => {
    const target = toVultrSshTarget(toHostInstance(instance({ powerStatus: "stopped" })));
    expect(target?.host).toBe("root@45.32.10.1");
    expect(target?.instance.state).toBe("stopped");
  });

  test("environment is left blank rather than guessed from free-form tags", () => {
    const target = toVultrSshTarget(toHostInstance(instance({ tags: ["production", "db"] })));
    expect(target?.environment).toBeUndefined();
  });

  test("IPv6 is used only when there is no IPv4", () => {
    const v6Only = instance({ mainIp: undefined, v6MainIp: "2001:db8::1" });
    expect(toVultrSshTarget(toHostInstance(v6Only))?.host).toBe("root@2001:db8::1");
  });
});

describe("VultrManager reads the API v2 shapes", () => {
  test("normalizes an instance and follows cursor pagination to the end", async () => {
    const { calls } = stubFetch((url) => {
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        return { instances: [raw()], meta: { total: 2, links: { next: "page2" } } };
      }
      return { instances: [raw({ id: "i_2", label: "api-02" })], meta: { links: { next: "" } } };
    });

    const instances = await new VultrManager("key").listInstances();

    expect(instances).toHaveLength(2);
    expect(instances[0]).toMatchObject({
      label: "api-01",
      mainIp: "45.32.10.1",
      ramMb: 1024,
      diskGb: 25,
      userScheme: "root",
      createdAt: Date.parse("2026-01-02T03:04:05+00:00"),
    });
    expect(calls.map((call) => call.url.searchParams.get("cursor"))).toEqual([null, "page2"]);
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer key" });
  });

  test("an address Vultr has not assigned yet reads as absent, not as 0.0.0.0", async () => {
    stubFetch(() => ({
      instances: [raw({ status: "pending", main_ip: "0.0.0.0", v6_main_ip: "" })],
    }));

    const [pending] = await new VultrManager("key").listInstances();

    expect(pending.mainIp).toBeUndefined();
    expect(pending.v6MainIp).toBeUndefined();
  });

  test("an account has no id of its own, so its email identifies it", async () => {
    stubFetch(() => ({ account: { name: "Acme", email: "ops@acme.dev", acls: ["subscriptions"] } }));

    expect(await createVultrHostProvider(new VultrManager("key")).account()).toMatchObject({
      id: "ops@acme.dev",
      username: "ops@acme.dev",
      name: "Acme",
    });
  });

  test("an API failure surfaces Vultr's own message and status", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: "Invalid API key.", status: 401 }), { status: 401 }),
    );

    await expect(new VultrManager("bad").listInstances()).rejects.toMatchObject({
      name: "VultrApiError",
      message: "Invalid API key.",
      status: 401,
    });
    await expect(new VultrManager("bad").listInstances()).rejects.toBeInstanceOf(VultrApiError);
  });
});

describe("the write half is separate and speaks Vultr's action names", () => {
  test("each action hits its own power endpoint with POST", async () => {
    // Power endpoints answer 204 with no body; an empty body must not be a parse error.
    const { calls } = stubFetch(() => new Response(null, { status: 204 }));
    const actions = createVultrHostActions(new VultrActions({ token: "key" }));

    await actions.run("start", "i_1");
    await actions.run("halt", "i_1");
    await actions.run("reboot", "i_1");

    expect(calls.map((call) => `${call.init?.method} ${call.url.pathname}`)).toEqual([
      "POST /v2/instances/i_1/start",
      "POST /v2/instances/i_1/halt",
      "POST /v2/instances/i_1/reboot",
    ]);
  });

  test("an action the provider does not offer is refused by name", async () => {
    const actions = createVultrHostActions(new VultrActions({ token: "key" }));
    await expect(actions.run("destroy", "i_1")).rejects.toThrow(/does not support the action/);
  });
});

describe("auth reuses the shared three-source model at its narrowest", () => {
  test("VULTR_API_KEY is an ambient credential, read at use time", async () => {
    vi.stubEnv("VULTR_API_KEY", "env-key");
    // No `currentScope`: Vultr has no team or sub-account to inherit.
    expect(await readVultrEnvSession(process.env)).toEqual({ token: "env-key" });
  });

  test("no environment key means not connected, never an error to explain", async () => {
    expect(await readVultrEnvSession({})).toBeNull();
  });

  test("Vultr declines browser sign-in, which the shared spec allows", () => {
    expect(VULTR_AUTH.oauth).toBeUndefined();
    expect(VULTR_AUTH.id).toBe("vultr");
  });
});
