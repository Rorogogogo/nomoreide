import { HISTORY_PLOT_BOTTOM, HISTORY_PLOT_TOP } from "./activity-plot-bounds";

/**
 * Pure formatting and geometry for the activity views.
 *
 * None of it touches React or the API — it turns numbers into an SVG path, a
 * byte count, or a Tailwind class — so it sits apart from the components that
 * render it and is directly testable.
 */

export function chartPath(
  values: Array<number | null>,
  totalPoints = values.length,
): string {
  const lastIndex = Math.max(1, totalPoints - 1);
  let drawing = false;
  return values
    .map((value, index) => {
      if (value === null) {
        drawing = false;
        return "";
      }
      const x = (index / lastIndex) * 1000;
      const y = historyPlotY(value);
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
}

export function historyPlotY(value: number): number {
  const clamped = Math.min(100, Math.max(0, value));
  const height = HISTORY_PLOT_BOTTOM - HISTORY_PLOT_TOP;
  return HISTORY_PLOT_TOP + ((100 - clamped) / 100) * height;
}

export function toneClassName(
  tone: "amber" | "emerald" | "sky" | "violet",
  part: "bar" | "glow" | "icon" | "stroke",
) {
  const classes = {
    amber: {
      bar: "bg-amber-500",
      glow: "bg-amber-500",
      icon: "text-amber-600 dark:text-amber-400",
      stroke: "stroke-amber-500",
    },
    emerald: {
      bar: "bg-emerald-500",
      glow: "bg-emerald-500",
      icon: "text-emerald-600 dark:text-emerald-400",
      stroke: "stroke-emerald-500",
    },
    sky: {
      bar: "bg-sky-500",
      glow: "bg-sky-500",
      icon: "text-sky-600 dark:text-sky-400",
      stroke: "stroke-sky-500",
    },
    violet: {
      bar: "bg-violet-500",
      glow: "bg-violet-500",
      icon: "text-violet-600 dark:text-violet-400",
      stroke: "stroke-violet-500",
    },
  };
  return classes[tone][part];
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    units.length - 1,
    Math.max(0, Math.floor(Math.log(value) / Math.log(1024))),
  );
  return `${(value / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatMb(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
