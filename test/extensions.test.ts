import { describe, expect, test } from "vitest";
import { listInstalledExtensions } from "../src/core/extensions.js";
import { deployProviders, hostProviders } from "../src/core/providers/registry.js";

/**
 * The Extensions inventory — stage 2 of §12.
 *
 * These assert the two things the page would be actively misleading about if
 * they drifted: that it lists *everything* installed, and that what it says a
 * plugin may reach is what the sandbox actually enforces.
 */
describe("installed extensions", () => {
  test("lists every registered provider from both registries", () => {
    const listed = listInstalledExtensions().map((extension) => extension.id);

    expect(listed).toEqual([
      ...deployProviders.map((provider) => provider.manifest.id),
      ...hostProviders.map((provider) => provider.manifest.id),
    ]);
  });

  /**
   * The row exists to be a disclosure, so it has to be the same list
   * `createProviderFetch` refuses everything outside of. A page that showed a
   * hand-maintained copy would be worse than showing nothing.
   */
  test("the hosts shown are the hosts the sandbox enforces", () => {
    const manifests = new Map(
      [...deployProviders, ...hostProviders].map((provider) => [
        provider.manifest.id,
        provider.manifest.api.hosts,
      ]),
    );

    for (const extension of listInstalledExtensions()) {
      expect(extension.hosts, `${extension.id} discloses the wrong hosts`).toEqual(
        manifests.get(extension.id),
      );
    }
  });

  /**
   * The §7 payoff, asserted so a later refactor cannot quietly split the server
   * list by vendor. Every plugin owns a page now (§12's two-layer nav), but a
   * host plugin's machines still belong in the one list the user already has,
   * beside machines no plugin owns — `mergesInto` is what says so on screen.
   */
  test("a host plugin still merges its machines into the server list", () => {
    const vultr = listInstalledExtensions().find((extension) => extension.id === "vultr");

    expect(vultr?.kind).toBe("host");
    expect(vultr?.mergesInto).toBe("servers");
  });

  /**
   * A deploy plugin's data has nowhere else to be: its projects and deployments
   * render on its own page. Claiming otherwise would send the reader to a page
   * that shows them nothing.
   */
  test("a deploy plugin merges into nothing", () => {
    const deploys = listInstalledExtensions().filter((extension) => extension.kind === "deploy");

    expect(deploys.length).toBeGreaterThan(1);
    for (const extension of deploys) {
      expect(extension.mergesInto, `${extension.id} points somewhere it has no rows`).toBeNull();
    }
  });

  test("productionAffecting is a subset of the actions shown", () => {
    for (const extension of listInstalledExtensions()) {
      for (const action of extension.productionAffecting) {
        expect(extension.actions, `${extension.id} marks an action it does not list`).toContain(
          action,
        );
      }
    }
  });
});
