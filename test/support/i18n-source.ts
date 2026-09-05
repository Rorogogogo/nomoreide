import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const catalogs = resolve(__dirname, "../../apps/dashboard/src/lib/i18n");

/**
 * Every string in a locale's catalog, as one blob of source text.
 *
 * The catalogs used to be a single `en.ts` / `zh.ts` that a test could
 * `readFileSync`. They are now one module per feature, so the tests that grep
 * the catalog for a rendered sentence — rather than importing it, because they
 * are asserting on the *copy*, not the key — concatenate the directory here
 * instead of hard-coding a file that no longer exists.
 *
 * `index.ts` is skipped: it re-exports the modules and holds no copy of its own.
 */
export function catalogSource(locale: "en" | "zh"): string {
  const dir = join(catalogs, locale);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}
