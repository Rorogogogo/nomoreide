import { describe, expect, test } from "vitest";
import { deployProviders, hostProviders } from "../src/core/providers/registry.js";

/**
 * `authSources` is declared data, but it describes something the code already
 * knows independently — whether the provider supplied an `oauth` spec and a
 * `cliSession` reader. The generic setup screen hides its "sign in with
 * browser" button on this field, so a manifest that drifts from its auth spec
 * either offers a button that cannot work or hides one that would.
 */
describe("deploy provider manifests", () => {
  test("authSources matches what each provider's auth spec supports", () => {
    for (const provider of deployProviders) {
      const declared = [...provider.manifest.authSources].sort();
      const actual = [
        "stored",
        ...(provider.auth.cliSession ? ["cli"] : []),
        ...(provider.auth.oauth ? ["oauth"] : []),
      ].sort();

      expect(declared, `${provider.manifest.id} declares the wrong auth sources`).toEqual(actual);
    }
  });

  test("only Vercel offers a browser sign-in today", () => {
    const withOAuth = deployProviders
      .filter((provider) => provider.manifest.authSources.includes("oauth"))
      .map((provider) => provider.manifest.id);

    expect(withOAuth).toEqual(["vercel"]);
  });

  test("every declared action is distinct and productionAffecting is a subset", () => {
    for (const { manifest } of deployProviders) {
      expect(new Set(manifest.actions).size, `${manifest.id} repeats an action`).toBe(
        manifest.actions.length,
      );
      for (const action of manifest.productionAffecting) {
        expect(manifest.actions, `${manifest.id} guards an action it does not offer`).toContain(
          action,
        );
      }
    }
  });
});

/**
 * The egress allowlist is only a boundary if every provider actually has one.
 * These run across *both* registries: a host provider sits in the same daemon
 * as a deploy provider and gets no softer a rule for it.
 */
describe("provider egress allowlists", () => {
  const manifests = [
    ...deployProviders.map((provider) => provider.manifest),
    ...hostProviders.map((provider) => provider.manifest),
  ];

  test("every provider declares at least one host", () => {
    for (const manifest of manifests) {
      expect(manifest.api.hosts, `${manifest.id} declares no hosts`).not.toHaveLength(0);
    }
  });

  /**
   * A bare hostname, because that is what the check compares against. A value
   * carrying a scheme or a path would never match `url.hostname` and would fail
   * as a silent deny at the first request rather than here.
   */
  test("hosts are bare hostnames, not URLs", () => {
    for (const manifest of manifests) {
      for (const host of manifest.api.hosts) {
        expect(host, `${manifest.id} declares a host that is not bare`).toMatch(
          /^[a-z0-9.-]+$/,
        );
      }
    }
  });

  /**
   * Wildcards are not supported, and the reason is worth pinning: every vendor
   * here has a customer-controlled subdomain space, so `*.vercel.com` would
   * read as a convenience while admitting hosts the vendor does not control.
   */
  test("no wildcard hosts", () => {
    for (const manifest of manifests) {
      for (const host of manifest.api.hosts) {
        expect(host, `${manifest.id} declares a wildcard host`).not.toContain("*");
      }
    }
  });
});
