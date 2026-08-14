import {
  deployProviders,
  hostProviders,
} from "./providers/registry.js";

/**
 * The installed-extension inventory — one neutral row per plugin, flattened
 * from both provider registries.
 *
 * Stage 2 of §12 of `docs/plans/2026-08-13-provider-registry-design.md`: the
 * Extensions section manages plugins, it does not *host* their features. A
 * deploy plugin's features live under Deploy; a host plugin's instances live in
 * the SSH server list via `providers/host-bridge.ts`. This module answers only
 * "what do I have, what may it do, and what may it reach".
 *
 * **Why the two registries flatten here rather than in the route.** Kind is a
 * *field* on the answer, not a shape difference in it. The two contracts stay
 * disjoint everywhere they disagree — that is §2 — but an inventory is one of
 * the few places they genuinely agree, because what an inventory reports is the
 * manifest, and both manifests carry an id, a name, an action list and an
 * egress allowlist. Keeping the flattening in core means the MCP surface and a
 * future CLI `nomoreide extensions` get the same rows without going through
 * HTTP.
 *
 * Deliberately **read-only, and there is nothing yet to write**: every
 * extension is `built-in`, so there is no install and no remove. The page says
 * so rather than rendering disabled buttons — see §12.
 */

/**
 * Where an extension came from.
 *
 * Only `built-in` exists today. The field is here because it is the question
 * the whole section is organized around, and a row that cannot state its own
 * provenance is exactly the row a user should not trust. `registry` and
 * `github` join it at stage 3.
 */
export type ExtensionSource = "built-in";

/** What kind of thing an extension is — which is also where its features appear. */
export type ExtensionKind = "deploy" | "host";

export interface InstalledExtension {
  id: string;
  name: string;
  kind: ExtensionKind;
  source: ExtensionSource;
  /**
   * Optional reads the plugin declares (deploy plugins only). Empty for a host
   * plugin, which has no capability list because it has no optional reads —
   * `HostProvider` is small enough that everything on it is required.
   */
  capabilities: string[];
  /** Named write operations the plugin accepts. */
  actions: string[];
  /** The subset of `actions` the UI confirms before running. */
  productionAffecting: string[];
  /**
   * Every host this plugin may reach, from its manifest's `api.hosts`.
   *
   * This is the field that earns the page. Enforced invisibly by
   * `createProviderFetch` since §11's gate item 3; showing it turns enforcement
   * into **disclosure**, which is the sentence a user needs before installing
   * anything. Built while every answer is still verifiable in-tree, so that the
   * surface is trustworthy by the time an answer is not.
   */
  hosts: string[];
  /**
   * Where this plugin's features actually appear in the app, as a page id.
   *
   * Present because the page's job is to send someone to the thing they
   * installed. `null` for a plugin with no page of its own — Vultr, whose
   * instances merge into the existing server list rather than getting a tab,
   * which is the payoff §7 was written for.
   */
  page: string | null;
}

/**
 * Everything installed, deploy plugins first.
 *
 * Synchronous and unsorted beyond that: both registries are static arrays, so
 * the order is the order a provider was added, and stability matters more than
 * alphabetization for a list this short.
 */
export function listInstalledExtensions(): InstalledExtension[] {
  return [
    ...deployProviders.map(({ manifest }) => ({
      id: manifest.id,
      name: manifest.name,
      kind: "deploy" as const,
      source: "built-in" as const,
      capabilities: [...manifest.capabilities],
      actions: [...manifest.actions],
      productionAffecting: [...manifest.productionAffecting],
      hosts: [...manifest.api.hosts],
      // Every deploy plugin renders through the one generic view, reached by
      // its in-view switcher — which is why this is a constant and not a
      // per-provider field.
      page: "deploy",
    })),
    ...hostProviders.map(({ manifest }) => ({
      id: manifest.id,
      name: manifest.name,
      kind: "host" as const,
      source: "built-in" as const,
      capabilities: [],
      actions: [...manifest.actions],
      productionAffecting: [...manifest.productionAffecting],
      hosts: [...manifest.api.hosts],
      // Not null: a host plugin's instances become rows in the SSH server list,
      // so "where did my plugin go" has a real answer even without a tab.
      page: "servers",
    })),
  ];
}
