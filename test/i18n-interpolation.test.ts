import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");
const clientSrc = resolve(root, "src/web/client/src");
const enPath = resolve(clientSrc, "lib/i18n/en.ts");

/**
 * Keys whose English copy carries a `{placeholder}`, mapped to the parameter
 * names it expects.
 *
 * `en.ts` is the source of truth for the key set, so it is also the source of
 * truth for which keys are interpolated — `zh.ts` is a `Partial` and a key
 * missing there renders English rather than failing.
 */
function interpolatedKeys(): Map<string, string[]> {
  const source = readFileSync(enPath, "utf8");
  const keys = new Map<string, string[]>();
  // Values may be wrapped onto the next line by the formatter, so the value is
  // matched across the newline that Biome inserts after `":"`.
  const entry = /^\s*"([^"]+)":\s*\n?\s*"((?:[^"\\]|\\.)*)"/gm;
  for (const match of source.matchAll(entry)) {
    const placeholders = [...match[2].matchAll(/\{([a-zA-Z]\w*)\}/g)].map((p) => p[1]);
    if (placeholders.length > 0) keys.set(match[1], [...new Set(placeholders)]);
  }
  return keys;
}

/** Every client source file that could call `t()`, i18n catalogues excluded. */
function clientSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name !== "node_modules") walk(path);
      } else if (/\.tsx?$/.test(item.name) && !path.startsWith(join(clientSrc, "lib", "i18n"))) {
        files.push(path);
      }
    }
  };
  walk(clientSrc);
  return files;
}

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("i18n interpolation", () => {
  /**
   * The bug this catches shipped once: `provider-setup.tsx` rendered the
   * literal `{name} access token` into a placeholder, because the key was
   * translated but never given its parameter. Nothing failed — `t()` returns
   * the raw string when a placeholder has no value, so a missing argument is
   * indistinguishable from correct copy until someone reads the screen.
   *
   * That is the same hazard `provider-strings.test.ts` covers for the manifest
   * side: only a test tells "deliberately lenient" from "quietly broken".
   */
  test("every t() call for an interpolated key passes its parameters", () => {
    const keys = interpolatedKeys();
    expect(keys.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of clientSources()) {
      const source = readFileSync(file, "utf8");
      for (const key of keys.keys()) {
        if (!source.includes(`"${key}"`)) continue;
        // A call closed immediately after the key passed no parameters at all.
        const bare = new RegExp(`\\bt\\(\\s*"${escapeForRegExp(key)}"\\s*\\)`, "g");
        for (const _ of source.matchAll(bare)) {
          offenders.push(`${relative(root, file)}: t("${key}") — needs ${keys.get(key)?.join(", ")}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("zh keeps the same placeholders as en, so neither renders a literal brace", () => {
    const zh = readFileSync(resolve(clientSrc, "lib/i18n/zh.ts"), "utf8");
    const zhEntry = /^\s*"([^"]+)":\s*\n?\s*"((?:[^"\\]|\\.)*)"/gm;
    const zhValues = new Map(
      [...zh.matchAll(zhEntry)].map((match) => [match[1], match[2]] as const),
    );

    const mismatched: string[] = [];
    for (const [key, expected] of interpolatedKeys()) {
      const translated = zhValues.get(key);
      // zh is a Partial: an absent key falls back to English, which is fine.
      if (translated === undefined) continue;
      const actual = [...new Set([...translated.matchAll(/\{([a-zA-Z]\w*)\}/g)].map((p) => p[1]))];
      if ([...actual].sort().join(",") !== [...expected].sort().join(",")) {
        mismatched.push(`${key}: en has {${expected.join("}, {")}}, zh has {${actual.join("}, {")}}`);
      }
    }

    expect(mismatched).toEqual([]);
  });
});
