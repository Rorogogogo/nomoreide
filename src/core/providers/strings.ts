/**
 * A provider's own words, carried in its manifest instead of in the host's
 * translation catalogue.
 *
 * This is §11 gate item 2. The rule that decides where a string lives is not
 * "is it about a provider" — most of the deploy view is — but **who determines
 * the set of keys**:
 *
 * - "No deployments yet." is one sentence for every provider. The host owns it,
 *   it stays in `i18n/en.ts`, and adding a provider does not touch it.
 * - "Promote" is one of *Vercel's* four action names. Cloudflare has two of
 *   them, Vultr has three entirely different ones, and provider #4 will invent
 *   a word nobody has typed yet. The host cannot hold a key it cannot know, so
 *   the provider carries it.
 *
 * Before this, `provider.action.promote` sat in `en.ts`/`zh.ts` and the view
 * hard-coded the union `"redeploy" | "cancel" | "promote" | "rollback"` — which
 * is why a provider declaring `actions: ["publish"]` got a `t()` call returning
 * the raw key and no button to put it on. That is tax #2, and paying it is what
 * makes the declarative half of the manifest genuinely declarative.
 *
 * `scopeLabel` moved here for a sharper reason: it was a **raw English string
 * in the manifest** (`"Team"` / `"Account"`) rendered straight into the DOM, so
 * it was never translated at all. A zh user read "Team". Moving it into a
 * locale bundle is the difference between a translated app and one that merely
 * looks translated.
 */

/**
 * The locales a manifest may carry — deliberately the same two as the client's
 * `Language`, and no wider.
 *
 * Re-declared here rather than imported because `src/core` must not depend on
 * `apps/dashboard` (the client is excluded from the server tsconfig and built
 * separately). `test/provider-strings.test.ts` asserts the two lists agree, so
 * adding a third language to the client fails there rather than silently
 * leaving every provider unable to speak it.
 */
export type ProviderLocale = "en" | "zh";

export const PROVIDER_LOCALES: readonly ProviderLocale[] = ["en", "zh"];

/**
 * One locale's worth of a provider's strings.
 *
 * Keys are flat and namespaced by what they describe:
 *
 * | Key | Required when |
 * | --- | --- |
 * | `scope.label` | the provider has scopes (deploy providers) |
 * | `action.<name>` | for every name in `manifest.actions` — the button |
 * | `action.<name>.done` | for every name in `manifest.actions` — the toast |
 * | `action.<name>.confirmTitle` | for every name in `productionAffecting` |
 * | `action.<name>.confirm` | for every name in `productionAffecting` |
 *
 * "Required" is enforced by `test/provider-strings.test.ts`, not by the type: a
 * `Record<string, string>` is what a manifest parsed from JSON produces, and
 * stage 3 of §12 is where that JSON arrives. A type cannot check a key set that
 * depends on the value of a sibling field anyway.
 */
export type ProviderStringBundle = Record<string, string>;

/**
 * A manifest's strings, one bundle per locale.
 *
 * **`en` is required and the rest are optional, and that asymmetry is the whole
 * design.** It mirrors the host's own catalogue exactly — `en.ts` defines the
 * key type, `zh.ts` is a `Partial` — so there is one mental model rather than
 * two. It also states the right thing about third-party plugins: an author in
 * one country can ship English only and their plugin works, because lookup
 * falls back rather than failing.
 *
 * The cost of that generosity is the one §9 named: a partial locale is
 * *silent*. So the leniency lives in the type, where a plugin needs it, and the
 * strictness lives in the test, which covers what this repo ships — every
 * in-tree provider must be complete in every locale, and a missing zh key fails
 * CI instead of quietly rendering English.
 */
export interface ProviderStrings {
  en: ProviderStringBundle;
  zh?: ProviderStringBundle;
}

/**
 * Resolve one key, falling back through locale → English → undefined.
 *
 * Returning `undefined` rather than the key itself is deliberate, and differs
 * from the host's `t()`, which renders the key as a loud dev tell. Here the
 * caller has something better to fall back to: an action's own name is a
 * serviceable button label, so a plugin that forgot `action.publish` shows
 * "publish" rather than "action.publish". The host has no such fallback for its
 * own keys, which is why the two resolvers differ.
 */
export function providerString(
  strings: ProviderStrings | undefined,
  locale: ProviderLocale,
  key: string,
): string | undefined {
  if (!strings) return undefined;
  return strings[locale]?.[key] ?? strings.en[key];
}

/** The keys a manifest must define, given the actions it declares. */
export function requiredStringKeys(manifest: {
  actions: readonly string[];
  productionAffecting: readonly string[];
  kind: string;
}): string[] {
  const keys: string[] = [];
  // Only deploy providers have scopes; a host provider's instances are not
  // grouped under anything the user picks between.
  if (manifest.kind === "deploy") keys.push("scope.label");
  for (const action of manifest.actions) {
    keys.push(`action.${action}`, `action.${action}.done`);
  }
  for (const action of manifest.productionAffecting) {
    keys.push(`action.${action}.confirmTitle`, `action.${action}.confirm`);
  }
  return keys;
}
