import type { ContextItem, ContextRef } from "@/lib/api";

/**
 * How a context entry is identified and coloured.
 *
 * Shared by the view, the tree and the preview panel — the three of them agree
 * on one key format, which is what lets a selection made in one be recognised
 * by the others.
 */

export function key(ref: ContextRef) {
  return `${ref.kind}:${ref.id}`;
}

export function kindDot(kind: ContextItem["kind"]): string {
  return { note: "bg-sky-500", project: "bg-emerald-500", service: "bg-violet-500", file: "bg-zinc-500", incident: "bg-rose-500", session: "bg-amber-500" }[kind];
}
