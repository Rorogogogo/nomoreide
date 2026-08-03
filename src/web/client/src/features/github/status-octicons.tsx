import { cn } from "@/lib/utils";

// GitHub's own run-status marks (octicons `check-circle-fill`,
// `x-circle-fill`, `dot-fill`). Source: primer/octicons, 16px set.
//
// These are solid discs with the glyph knocked out by the fill rule, which is
// what a workflow run looks like on GitHub — the outlined lucide equivalents
// read as a different, lighter state at these sizes. Colour comes from the
// caller via `currentColor` so both themes keep their own greens and reds.

export function CheckCircleFill({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("size-4", className)}
      fill="currentColor"
      viewBox="0 0 16 16"
    >
      <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z" />
    </svg>
  );
}

export function XCircleFill({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("size-4", className)}
      fill="currentColor"
      viewBox="0 0 16 16"
    >
      <path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z" />
    </svg>
  );
}

/**
 * In progress: a dot inside a ring whose bright arc rotates — GitHub's own
 * running mark. A static dot (even pulsing) reads as a *state* the run is
 * parked in; the rotation is what says work is happening right now, which is
 * the one thing you want to know while watching a run.
 */
export function RunningRing({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-flex size-4 items-center justify-center", className)}
    >
      <svg
        className="absolute inset-0 size-full animate-spin motion-reduce:animate-none"
        fill="none"
        viewBox="0 0 16 16"
      >
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
        <path
          d="M8 1a7 7 0 0 1 7 7"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
        />
      </svg>
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}

/**
 * Skipped or cancelled — a run that never reached a verdict. Distinct from
 * both the green check and the red X: nothing passed, but nothing broke
 * either, and conflating it with failure makes a clean build look red.
 */
export function SkipCircle({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("size-4", className)}
      fill="none"
      viewBox="0 0 16 16"
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.7 4.7 11.3 11.3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

/** Solid disc — the neutral conclusions and anything not yet started. */
export function DotCircleFill({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("size-4", className)}
      fill="currentColor"
      viewBox="0 0 16 16"
    >
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Z" />
    </svg>
  );
}
