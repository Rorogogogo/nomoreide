import { describe, expect, test } from "vitest";
import { en } from "../apps/dashboard/src/lib/i18n/en";
import { zh } from "../apps/dashboard/src/lib/i18n/zh";

/**
 * Key *coverage* parity between the catalogs.
 *
 * `i18n-interpolation.test.ts` already checks that a key present in both keeps
 * the same `{placeholders}`. What nothing checked is whether the key is there
 * at all: `zh` is typed `Partial<Record<TranslationKey, string>>`, so omitting
 * one is legal TypeScript and renders the English string instead. That is a
 * silent failure — no build breaks, no key shows through, the sentence just
 * comes out in the wrong language — and it is exactly how 37 keys drifted
 * before this test existed.
 *
 * The catalogs are imported rather than parsed because they are plain objects;
 * a regex over the source would also have to model the formatter's line wraps.
 */
describe("i18n key parity", () => {
  test("every English key has a Simplified Chinese translation", () => {
    const missing = Object.keys(en).filter((key) => !(key in zh));

    expect(
      missing,
      `${missing.length} key(s) would render English inside the Chinese UI. ` +
        `Add them to zh.ts in the same change that added them to en.ts.`,
    ).toEqual([]);
  });

  test("zh carries no key that en has dropped", () => {
    const stale = Object.keys(zh).filter((key) => !(key in en));

    expect(
      stale,
      `${stale.length} key(s) survive in zh.ts with nothing in en.ts to match. ` +
        `A removed feature should take both catalogs' keys with it.`,
    ).toEqual([]);
  });

  /**
   * Keys whose Chinese rendering is intentionally the English string.
   *
   * The catalog leaves a platform's own UI nouns alone — `github.tab.issues`
   * and `github.tab.actions` are already untranslated, because that is what
   * GitHub's Chinese users call them — and product names have no translation
   * to give. Both are decisions, not drift, so they are named here rather than
   * weakening the check for everything.
   */
  const sameInBothLocales = new Set<string>([
    "github.tab.prs", // GitHub's own tab noun, like Issues and Actions beside it
    "services.kind.dockerCompose", // product name
  ]);

  test("no translation is left as its English source string", () => {
    // A copied-but-untranslated value is the other way a key passes the check
    // above while still rendering English. Values that are deliberately
    // identical across locales — bare numbers, product names, punctuation —
    // are not flagged, only ones carrying actual Latin prose.
    const prose = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/;
    const untranslated = Object.entries(zh)
      .filter(
        ([key, value]) =>
          !sameInBothLocales.has(key) &&
          value === en[key as keyof typeof en] &&
          prose.test(String(value)),
      )
      .map(([key]) => key);

    expect(
      untranslated,
      `${untranslated.length} zh value(s) are verbatim English prose.`,
    ).toEqual([]);
  });
});
