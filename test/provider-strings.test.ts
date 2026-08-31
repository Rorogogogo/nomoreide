import { describe, expect, test } from "vitest";
import { deployProviders, hostProviders } from "../src/core/providers/registry.js";
import {
  PROVIDER_LOCALES,
  providerString,
  requiredStringKeys,
  type ProviderStrings,
} from "../src/core/providers/strings.js";
import { LANGUAGE_OPTIONS } from "../apps/dashboard/src/lib/language.js";

/**
 * The test §9 asks for, and the reason §11 gate item 2 could be paid at all.
 *
 * `zh.ts` is a `Partial`, so a missing key renders English rather than failing
 * any build. Moving a provider's action labels into its manifest inherits that
 * hazard and makes it worse: `ProviderStrings.zh` is optional *by design*, so a
 * third-party plugin may ship English only and still work. That leniency is
 * right for the type and wrong for this repo — nothing in-tree should be
 * half-translated, and nothing but a test can tell the two cases apart.
 *
 * So: the type permits what a plugin needs, and this file enforces what we ship.
 */

const manifests = [
  ...deployProviders.map(({ manifest }) => manifest),
  ...hostProviders.map(({ manifest }) => manifest),
];

/** Every locale a manifest must cover, as a plain list of bundles that exist. */
function bundles(strings: ProviderStrings): [string, Record<string, string> | undefined][] {
  return PROVIDER_LOCALES.map((locale) => [locale, strings[locale]]);
}

describe("provider manifest strings", () => {
  test("every provider declares strings for every locale", () => {
    for (const manifest of manifests) {
      for (const [locale, bundle] of bundles(manifest.strings)) {
        expect(bundle, `${manifest.id} has no ${locale} strings`).toBeDefined();
      }
    }
  });

  /**
   * The parity check itself. Key *sets* must match exactly across locales —
   * not merely "zh covers en", because a zh-only key is just as wrong: it is a
   * string no English reader can ever see, which means it is either dead or
   * evidence the two bundles drifted apart in an edit.
   */
  test("locales carry identical key sets", () => {
    for (const manifest of manifests) {
      const english = Object.keys(manifest.strings.en).sort();
      for (const [locale, bundle] of bundles(manifest.strings)) {
        expect(
          Object.keys(bundle ?? {}).sort(),
          `${manifest.id}'s ${locale} strings do not match its English ones`,
        ).toEqual(english);
      }
    }
  });

  test("no string is left untranslated by copy-paste", () => {
    for (const manifest of manifests) {
      for (const [key, english] of Object.entries(manifest.strings.en)) {
        // `scope.label` legitimately repeats across locales when it is mostly a
        // brand name, so only the sentences are checked — a confirmation or a
        // toast identical to its English source is an untranslated leftover.
        if (!key.endsWith(".confirm") && !key.endsWith(".done")) continue;
        expect(
          manifest.strings.zh?.[key],
          `${manifest.id}'s zh "${key}" is still the English string`,
        ).not.toBe(english);
      }
    }
  });

  /**
   * The keys are not free-form: the manifest's own `actions` and
   * `productionAffecting` determine which must exist. A provider that adds an
   * action and forgets its label fails here rather than rendering a button
   * captioned with a raw action name.
   */
  test("every declared action has a label and a completion toast", () => {
    for (const manifest of manifests) {
      for (const key of requiredStringKeys(manifest)) {
        for (const locale of PROVIDER_LOCALES) {
          expect(
            providerString(manifest.strings, locale, key),
            `${manifest.id} is missing "${key}" in ${locale}`,
          ).toBeTruthy();
        }
      }
    }
  });

  test("only production-affecting actions carry confirmation copy", () => {
    for (const manifest of manifests) {
      for (const action of manifest.actions) {
        if (manifest.productionAffecting.includes(action)) continue;
        expect(
          manifest.strings.en[`action.${action}.confirm`],
          `${manifest.id} writes a confirmation for "${action}", which it does not guard`,
        ).toBeUndefined();
      }
    }
  });

  test("no string is declared for an action the provider does not offer", () => {
    for (const manifest of manifests) {
      const required = new Set(requiredStringKeys(manifest));
      for (const key of Object.keys(manifest.strings.en)) {
        expect(required, `${manifest.id} declares an unused string "${key}"`).toContain(key);
      }
    }
  });

  /**
   * Only deploy providers have scopes, so only they may name one. A host
   * provider carrying a `scope.label` would be declaring a concept its contract
   * does not have — the kind of drift §2's two-contract split exists to catch.
   */
  test("only deploy providers name a scope", () => {
    for (const { manifest } of hostProviders) {
      expect(
        manifest.strings.en["scope.label"],
        `${manifest.id} is a host provider and has no scopes to label`,
      ).toBeUndefined();
    }
    for (const { manifest } of deployProviders) {
      expect(manifest.strings.en["scope.label"], `${manifest.id} does not name its scope`)
        .toBeTruthy();
    }
  });

  /**
   * `PROVIDER_LOCALES` is re-declared in `src/core` because core must not
   * import from `apps/dashboard`. This is what keeps the copy honest: adding a
   * language to the dashboard fails here until every provider can speak it,
   * rather than silently leaving every plugin English-only in the new locale.
   */
  test("the core locale list matches the languages the dashboard offers", () => {
    expect([...PROVIDER_LOCALES].sort()).toEqual(
      LANGUAGE_OPTIONS.map((option) => option.value).sort(),
    );
  });
});
