import { describe, expect, test } from "vitest";
import { deployProviders } from "../src/core/providers/registry.js";

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
