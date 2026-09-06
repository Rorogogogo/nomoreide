import { Eye, FunctionSquare, Table2, Workflow } from "lucide-react";
import type { DatabaseObjectKind } from "@/lib/api";

/** Catalog key handling and the icon for each object kind. */

export function categoryIcon(kind: DatabaseObjectKind): React.ReactNode {
  if (kind === "table") return <Table2 aria-hidden="true" className="size-3.5" />;
  if (kind === "view" || kind === "materializedView") return <Eye aria-hidden="true" className="size-3.5" />;
  if (kind === "function" || kind === "procedure") return <FunctionSquare aria-hidden="true" className="size-3.5" />;
  return <Workflow aria-hidden="true" className="size-3.5" />;
}

export function schemaKey(connection: string, schema: string): string {
  return `${connection}::${schema}`;
}

export function toggleList(current: string[], value: string): string[] {
  const next = current.filter((entry) => entry !== value);
  if (next.length === current.length) next.push(value);
  return next;
}

export function addToList(current: string[], value: string): string[] {
  return current.includes(value) ? current : [...current, value];
}

export function pruneList(
  current: string[],
  keep: (value: string) => boolean,
): string[] {
  const next = current.filter(keep);
  return next.length === current.length ? current : next;
}

export function hasConnectionPrefix(value: string, connections: Set<string>): boolean {
  const separator = value.indexOf("::");
  return separator > 0 && connections.has(value.slice(0, separator));
}
