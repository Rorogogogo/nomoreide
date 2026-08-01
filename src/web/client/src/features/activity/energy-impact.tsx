import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";

export type EnergyImpactLevel = "low" | "medium" | "high";

export interface EnergyImpact {
  level: EnergyImpactLevel;
  score: number;
}

/**
 * Relative energy-impact estimate. CPU dominates the score while resident
 * memory adds a smaller pressure signal; this is intentionally not wattage.
 */
export function estimateEnergyImpact(
  cpuPercent: number,
  memoryPercent: number | null,
): EnergyImpact {
  const score = Math.min(
    100,
    Math.max(0, cpuPercent) + Math.max(0, memoryPercent ?? 0) * 0.25,
  );
  return {
    score,
    level: score >= 50 ? "high" : score >= 20 ? "medium" : "low",
  };
}

export function EnergyImpactBadge({
  cpuPercent,
  memoryPercent,
}: {
  cpuPercent: number;
  memoryPercent: number | null;
}) {
  const t = useT();
  const impact = estimateEnergyImpact(cpuPercent, memoryPercent);
  const variant =
    impact.level === "high"
      ? "danger"
      : impact.level === "medium"
        ? "warning"
        : "secondary";
  return (
    <Badge
      size="small"
      title={t("activity.energy.estimate", { score: impact.score.toFixed(0) })}
      variant={variant}
    >
      {t(`activity.energy.${impact.level}`)}
    </Badge>
  );
}
