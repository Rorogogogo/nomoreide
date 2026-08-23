import { afterEach, describe, expect, test, vi } from "vitest";
import { cloudflareApiBase } from "../src/core/cloudflare-manager.js";
import { providerApiBase, providerApiHost } from "../src/core/providers/api-base.js";
import { vercelApiBase } from "../src/core/vercel-manager.js";
import { vultrApiBase } from "../src/core/vultr-manager.js";
import { VULTR_MANIFEST } from "../src/core/vultr-provider.js";

/**
 * The loopback-only override the deploy-provider gates need, and the reason it
 * is safe to have.
 *
 * The claim is narrow: an environment variable can point a provider at a
 * stand-in **on this machine and nowhere else**. Everything else about a
 * bad value is ignored rather than rejected, because this is read on a path
 * that has to keep working — a stray variable in an inherited environment must
 * degrade to the vendor, not break the dashboard.
 */

const VARIABLE = "NOMOREIDE_TEST_API_BASE";
const VENDOR = "https://api.vendor.test/v1";

afterEach(() => {
  delete process.env[VARIABLE];
  delete process.env.NOMOREIDE_VERCEL_API_BASE;
  delete process.env.NOMOREIDE_CLOUDFLARE_API_BASE;
  delete process.env.NOMOREIDE_VULTR_API_BASE;
});

describe("providerApiBase", () => {
  test("is the vendor when nothing overrides it", () => {
    expect(providerApiBase(VARIABLE, VENDOR)).toBe(VENDOR);
  });

  test.each([
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://localhost:1", "http://localhost:1"],
    ["https://127.0.0.1:8443", "https://127.0.0.1:8443"],
    // A trailing slash would double up against a path that starts with one.
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
    ["http://127.0.0.1:8080///", "http://127.0.0.1:8080"],
    ["  http://127.0.0.1:8080  ", "http://127.0.0.1:8080"],
  ])("accepts the loopback stand-in %s", (value, expected) => {
    process.env[VARIABLE] = value;
    expect(providerApiBase(VARIABLE, VENDOR)).toBe(expected);
  });

  /**
   * Every one of these is the case the loopback rule exists for: an override
   * that would put a bearer token somewhere it does not belong.
   */
  test.each([
    "https://api.evil.example",
    "http://169.254.169.254/latest/meta-data",
    "https://127.0.0.1.evil.example",
    "file:///etc/passwd",
    "ftp://127.0.0.1/x",
    "not a url",
    "",
    "   ",
  ])("ignores %s and stays with the vendor", (value) => {
    process.env[VARIABLE] = value;
    expect(providerApiBase(VARIABLE, VENDOR)).toBe(VENDOR);
  });
});

describe("providerApiHost", () => {
  test("is the hostname a scoped fetch has to admit", () => {
    expect(providerApiHost("https://api.vercel.com")).toBe("api.vercel.com");
    // A base with a path still allowlists only its host.
    expect(providerApiHost("https://api.cloudflare.com/client/v4")).toBe("api.cloudflare.com");
    expect(providerApiHost("http://127.0.0.1:8080")).toBe("127.0.0.1");
  });
});

describe("the providers that use it", () => {
  test("default to their vendor", () => {
    expect(vercelApiBase()).toBe("https://api.vercel.com");
    expect(cloudflareApiBase()).toBe("https://api.cloudflare.com/client/v4");
    expect(vultrApiBase()).toBe("https://api.vultr.com/v2");
  });

  test("follow their own variable and no one else's", () => {
    process.env.NOMOREIDE_VERCEL_API_BASE = "http://127.0.0.1:7001";
    expect(vercelApiBase()).toBe("http://127.0.0.1:7001");
    expect(cloudflareApiBase()).toBe("https://api.cloudflare.com/client/v4");
    expect(vultrApiBase()).toBe("https://api.vultr.com/v2");
  });

  /**
   * The allowlist is *derived* from the base rather than written beside it, so
   * the host a request may reach and the host it actually goes to cannot drift
   * apart — including when the base is a loopback stand-in.
   */
  test("keep the egress allowlist in step with the base", async () => {
    expect(VULTR_MANIFEST.api.hosts).toEqual(["api.vultr.com"]);

    process.env.NOMOREIDE_VULTR_API_BASE = "http://127.0.0.1:7003";
    vi.resetModules();
    const { VULTR_MANIFEST: reloaded } = await import("../src/core/vultr-provider.js");
    expect(reloaded.api.hosts).toEqual(["127.0.0.1"]);
  });
});
