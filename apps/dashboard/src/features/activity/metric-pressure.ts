export type MetricPressure = "high" | "low" | "medium";

export function metricPressure(percent: number | null): MetricPressure | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  if (percent >= 70) return "high";
  if (percent >= 30) return "medium";
  return "low";
}

export function metricPressureTextClass(percent: number | null): string {
  const pressure = metricPressure(percent);
  if (pressure === "high") return "text-rose-600 dark:text-rose-400";
  if (pressure === "medium") return "text-amber-600 dark:text-amber-400";
  if (pressure === "low") return "text-emerald-600 dark:text-emerald-400";
  return "text-muted-foreground";
}

export function metricPressureBarClass(percent: number | null): string {
  const pressure = metricPressure(percent);
  if (pressure === "high") return "bg-rose-500";
  if (pressure === "medium") return "bg-amber-500";
  if (pressure === "low") return "bg-emerald-500";
  return "bg-muted";
}
