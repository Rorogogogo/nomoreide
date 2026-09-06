/**
 * A widget's tone — what a counter *means*, never what it currently reads.
 *
 * The "failing" slot stays red whether it shows 2 or 0, which is what lets the
 * labels come off the dashboard: colour and position carry the meaning. Its own
 * module because the container and the counters both map a tone to classes.
 */

export type WidgetTone = "ok" | "warn" | "bad" | "idle";

export const TEXT_TONE: Record<WidgetTone, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-red-500",
  idle: "text-foreground",
};

/**
 * The same hues, faded, for a counter sitting at zero.
 *
 * Tone is a property of *what the counter means*, never of its current value —
 * the "failing" slot stays red whether it reads 2 or 0. That is what lets the
 * labels come off: colour and position carry the meaning instead of a word
 * under every number. Fading the zeros keeps a quiet page quiet, so the one
 * number that isn't zero is the one you see.
 */
export const DIM_TONE: Record<WidgetTone, string> = {
  ok: "text-emerald-500/35",
  warn: "text-amber-500/35",
  bad: "text-red-500/35",
  idle: "text-muted-foreground/50",
};

export const DOT_TONE: Record<WidgetTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  idle: "bg-zinc-500/60",
};
