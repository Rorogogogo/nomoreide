import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SPINNER_SIZE = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-6",
} as const;

type SpinnerSize = keyof typeof SPINNER_SIZE;

/**
 * The app's canonical spinner — a spinning `Loader2` that inherits the current
 * text color. Use inline inside buttons/badges, or via `<Loading>` for a
 * centered panel state. Standardizes the dozens of ad-hoc
 * `<Loader2 className="animate-spin" />` call sites onto one component.
 */
export function Spinner({
  size = "md",
  className,
}: {
  size?: SpinnerSize;
  className?: string;
}) {
  return <Loader2 aria-hidden className={cn("animate-spin", SPINNER_SIZE[size], className)} />;
}

/**
 * Centered spinner with an optional label for panel/section loading states.
 * `fill` makes it take the full height of its container (the common
 * "loading this view" case); otherwise it sits inline.
 */
export function Loading({
  label,
  size = "md",
  fill = false,
  className,
}: {
  label?: string;
  size?: SpinnerSize;
  fill?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 text-[12px] text-muted-foreground",
        fill && "h-full",
        className,
      )}
      role="status"
    >
      <Spinner size={size} />
      {label ? <span>{label}</span> : null}
    </div>
  );
}
