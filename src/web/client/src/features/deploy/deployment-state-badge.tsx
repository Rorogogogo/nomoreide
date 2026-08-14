import type { ProviderDeploymentState } from "@/lib/api";
import { useT, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  CanceledIcon,
  FailedIcon,
  PendingIcon,
  SpinnerIcon,
  VerifiedIcon,
} from "./provider-icons";

/**
 * One definition of how a deployment state looks, so the list row, the detail
 * header, and the header indicator can't drift on color or wording.
 */
const STATES: Record<
  ProviderDeploymentState,
  { labelKey: TranslationKey; className: string; dotClassName: string; spin?: boolean }
> = {
  ready: {
    labelKey: "provider.state.ready",
    className: "text-emerald-500",
    dotClassName: "bg-emerald-500",
  },
  building: {
    labelKey: "provider.state.building",
    className: "text-amber-500",
    dotClassName: "bg-amber-500",
    spin: true,
  },
  queued: {
    labelKey: "provider.state.queued",
    className: "text-muted-foreground",
    dotClassName: "bg-muted-foreground/50",
  },
  error: { labelKey: "provider.state.error", className: "text-red-500", dotClassName: "bg-red-500" },
  canceled: {
    labelKey: "provider.state.canceled",
    className: "text-muted-foreground",
    dotClassName: "bg-muted-foreground/50",
  },
  blocked: {
    labelKey: "provider.state.blocked",
    className: "text-muted-foreground",
    dotClassName: "bg-muted-foreground/50",
  },
  deleted: {
    labelKey: "provider.state.deleted",
    className: "text-muted-foreground",
    dotClassName: "bg-muted-foreground/50",
  },
};

/**
 * Vendor states that deserve a finer label than the neutral state they fold
 * into. This is what `rawState` is *for*: `INITIALIZING` and `BUILDING` are
 * both `building`, and without this the badge would silently start calling one
 * of them the other. A provider whose raw state isn't listed just reads as its
 * neutral state, which is always a true statement.
 */
const RAW_LABELS: Record<string, TranslationKey> = {
  INITIALIZING: "provider.state.initializing",
};

const specFor = (state: ProviderDeploymentState) => STATES[state] ?? STATES.queued;
const labelFor = (state: ProviderDeploymentState, rawState?: string): TranslationKey =>
  (rawState && RAW_LABELS[rawState]) || specFor(state).labelKey;

/**
 * A quieter stand-in for {@link DeploymentStateIcon} in dense lists — a row of
 * distinct colored icon shapes reads as noisy next to the hero and detail
 * pane, which already show the full icon+label for whichever deployment
 * matters most. Color alone still separates ready/building/error at a glance.
 */
export function DeploymentStateDot({
  state,
  className,
}: {
  state: ProviderDeploymentState;
  className?: string;
}) {
  const spec = specFor(state);
  return (
    <span
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        spec.dotClassName,
        spec.spin && "animate-pulse",
        className,
      )}
    />
  );
}

export function DeploymentStateIcon({
  state,
  className,
}: {
  state: ProviderDeploymentState;
  className?: string;
}) {
  const spec = specFor(state);
  const classes = cn("size-4 shrink-0", spec.className, className);
  if (spec.spin) return <SpinnerIcon className={cn(classes, "animate-spin")} />;
  // The verified-check glyph doubles as "ready" — same meaning, same drawing.
  if (state === "ready") return <VerifiedIcon className={classes} />;
  if (state === "error") return <FailedIcon className={classes} />;
  if (state === "canceled") return <CanceledIcon className={classes} />;
  return <PendingIcon className={classes} />;
}

export function DeploymentStateBadge({
  state,
  rawState,
}: {
  state: ProviderDeploymentState;
  /** The vendor's own word, when the caller has it — see {@link RAW_LABELS}. */
  rawState?: string;
}) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-medium",
        specFor(state).className,
      )}
    >
      <DeploymentStateIcon state={state} />
      {t(labelFor(state, rawState))}
    </span>
  );
}

export function useDeploymentStateLabel(): (
  state: ProviderDeploymentState,
  rawState?: string,
) => string {
  const t = useT();
  return (state, rawState) => t(labelFor(state, rawState));
}
