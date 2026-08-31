import { createContextNote } from "@/lib/api";

const PREFIX = "nomoreide:gist:current:";
const MIGRATED_PREFIX = "nomoreide:context:migrated-gist:";

interface LegacyPiece {
  id?: string;
  type?: "text" | "image";
  value?: string;
  name?: string;
}

/**
 * Imports browser-local Gist text into the Markdown vault once. Original keys
 * stay untouched so migration is recoverable and old builds still see them.
 */
export async function migrateLegacyGists(): Promise<number> {
  const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith(PREFIX)));
  let imported = 0;
  for (const key of keys) {
    if (window.localStorage.getItem(`${MIGRATED_PREFIX}${key}`)) continue;
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    let pieces: LegacyPiece[];
    try {
      const parsed = JSON.parse(raw) as { pieces?: LegacyPiece[]; body?: string };
      pieces = parsed.pieces ?? (parsed.body ? [{ type: "text", value: parsed.body }] : []);
    } catch {
      continue;
    }
    const text = pieces.flatMap((piece) => {
      const value = piece.type === "text" ? piece.value?.trim() : undefined;
      return value ? [value] : [];
    });
    const images = pieces.filter((piece) => piece.type === "image");
    if (!text.length && !images.length) {
      window.localStorage.setItem(`${MIGRATED_PREFIX}${key}`, "empty");
      continue;
    }
    const scope = key.slice(PREFIX.length);
    const imageNotice = images.length
      ? `\n\n> ${images.length} legacy Gist image${images.length === 1 ? " was" : "s were"} left in browser storage. The original Gist remains available for recovery.`
      : "";
    await createContextNote({
      title: scope === "all" ? "Workspace gist" : "Project gist",
      body: `${text.join("\n\n---\n\n")}${imageNotice}`.trim(),
      projectPaths: scope === "all" ? [] : [scope],
      tags: ["gist", "migrated"],
      sourceKey: key,
    });
    window.localStorage.setItem(`${MIGRATED_PREFIX}${key}`, new Date().toISOString());
    imported += 1;
  }
  return imported;
}
