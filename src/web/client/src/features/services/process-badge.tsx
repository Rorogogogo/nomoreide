import { Terminal } from "lucide-react";
import {
  siBun,
  siDeno,
  siDocker,
  siDotnet,
  siGo,
  siNodedotjs,
  siNpm,
  siPnpm,
  siPython,
  siRust,
  siVite,
  siYarn,
  type SimpleIcon,
} from "simple-icons/icons";
import { cn } from "@/lib/utils";
import { processKindForCommand, type ProcessKind } from "./process-kind";

export function ProcessBadge({
  command,
  compact,
}: {
  command: string;
  compact?: boolean;
}) {
  const process = processKindForCommand(command);
  const icon = processBadgeIcon[process.kind];

  return (
    <span
      aria-label={`${process.label} process`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border bg-card shadow-sm dark:bg-zinc-100",
        compact ? "size-6" : "size-7",
        icon ? "border-border" : "border-border bg-muted text-muted-foreground dark:bg-zinc-100 dark:text-zinc-700",
      )}
      style={icon ? { color: `#${icon.hex}` } : undefined}
      title={process.label}
    >
      {icon ? (
        <svg
          aria-hidden="true"
          className={compact ? "size-3.5" : "size-4"}
          fill="currentColor"
          role="img"
          viewBox="0 0 24 24"
        >
          <path d={icon.path} />
        </svg>
      ) : (
        <Terminal className={compact ? "size-3.5" : "size-4"} />
      )}
    </span>
  );
}

const processBadgeIcon: Record<ProcessKind, SimpleIcon | null> = {
  bun: siBun,
  cargo: siRust,
  deno: siDeno,
  dotnet: siDotnet,
  docker: siDocker,
  generic: null,
  go: siGo,
  node: siNodedotjs,
  npm: siNpm,
  pnpm: siPnpm,
  python: siPython,
  rust: siRust,
  vite: siVite,
  yarn: siYarn,
};
