import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const RELATIVE_TIME_UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/**
 * Human "5 minutes ago" / "3 days ago" string for an ISO timestamp. Returns
 * "just now" under a minute and an empty string for an unparseable input.
 */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60 * 1000) return "just now";
  for (const { unit, ms } of RELATIVE_TIME_UNITS) {
    if (abs >= ms) return relativeTimeFormat.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

/**
 * Compact elapsed-since string — `45s`, `12m`, `2h30m`, `3d4h`.
 *
 * Deliberately *not* `formatRelativeTime`: "2 hours ago" is the wrong reading
 * for a process that is still up. This is how long it has been running, so it
 * has to fit in a status cell beside a service name.
 */
export function formatUptime(startedAt?: string): string | undefined {
  if (!startedAt) return undefined;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return undefined;

  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${remMinutes ? `${remMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}
