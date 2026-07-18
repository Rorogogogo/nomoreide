import { readFileSync } from "node:fs";

let cached: string | undefined;

/** The installed nomoreide package version (from package.json, cached). */
export function appVersion(): string {
  if (cached === undefined) {
    try {
      const raw = readFileSync(
        new URL("../../package.json", import.meta.url),
        "utf8",
      );
      cached = String((JSON.parse(raw) as { version?: unknown }).version ?? "0.0.0");
    } catch {
      cached = "0.0.0";
    }
  }
  return cached;
}
