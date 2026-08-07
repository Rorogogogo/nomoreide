import type { VercelDeploymentState } from "@/lib/api";
import { useT, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  CanceledIcon,
  FailedIcon,
  PendingIcon,
  SpinnerIcon,
  VerifiedIcon,
} from "./vercel-icons";

/**
 * One definition of how a deployment state looks, so the list row, the detail
 * header, and the header indicator can't drift on color or wording.
 */
const STATES: Record<
  VercelDeploymentState,
  { labelKey: TranslationKey; className: string; spin?: boolean }
> = {
  READY: { labelKey: "vercel.state.ready", className: "text-emerald-500" },
  BUILDING: { labelKey: "vercel.state.building", className: "text-amber-500", spin: true },
  INITIALIZING: {
    labelKey: "vercel.state.initializing",
    className: "text-amber-500",
    spin: true,
  },
  QUEUED: { labelKey: "vercel.state.queued", className: "text-muted-foreground" },
  ERROR: { labelKey: "vercel.state.error", className: "text-red-500" },
  CANCELED: { labelKey: "vercel.state.canceled", className: "text-muted-foreground" },
  BLOCKED: { labelKey: "vercel.state.blocked", className: "text-muted-foreground" },
  DELETED: { labelKey: "vercel.state.deleted", className: "text-muted-foreground" },
};

export function DeploymentStateIcon({
  state,
  className,
}: {
  state: VercelDeploymentState;
  className?: string;
}) {
  const spec = STATES[state] ?? STATES.QUEUED;
  const classes = cn("size-4 shrink-0", spec.className, className);
  if (spec.spin) return <SpinnerIcon className={cn(classes, "animate-spin")} />;
  // The verified-check glyph doubles as "ready" — same meaning, same drawing.
  if (state === "READY") return <VerifiedIcon className={classes} />;
  if (state === "ERROR") return <FailedIcon className={classes} />;
  if (state === "CANCELED") return <CanceledIcon className={classes} />;
  return <PendingIcon className={classes} />;
}

export function DeploymentStateBadge({ state }: { state: VercelDeploymentState }) {
  const t = useT();
  const spec = STATES[state] ?? STATES.QUEUED;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", spec.className)}>
      <DeploymentStateIcon state={state} />
      {t(spec.labelKey)}
    </span>
  );
}

export function useDeploymentStateLabel(): (state: VercelDeploymentState) => string {
  const t = useT();
  return (state) => t((STATES[state] ?? STATES.QUEUED).labelKey);
}
