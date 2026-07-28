"use client";

import type React from "react";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

type BadgeVariant =
  | "primary"
  | "secondary"
  | "success"
  | "warning"
  | "error"
  | "danger"
  | "default"
  | "outline";
type BadgeAppearance = "solid" | "outline" | "subtle";
type NormalizedBadgeVariant = "primary" | "secondary" | "success" | "warning" | "error";

export type BadgeProps = {
  label?: string;
  children?: React.ReactNode;
  variant?: BadgeVariant;
  size?: "small" | "medium" | "large";
  icon?: React.ReactNode;
  onClick?: () => void;
  removable?: boolean;
  className?: string;
  maxWidth?: string | number;
  appearance?: BadgeAppearance;
  onRemove?: () => void;
  isLoading?: boolean;
};

const VARIANT_STYLES: Record<
  NormalizedBadgeVariant,
  Record<BadgeAppearance, string>
> = {
  primary: {
    solid: "border-transparent bg-primary text-primary-foreground",
    outline: "border-border bg-background text-foreground",
    subtle: "border-transparent bg-primary/10 text-foreground",
  },
  secondary: {
    solid: "border-transparent bg-secondary text-secondary-foreground",
    outline: "border-border bg-background text-foreground",
    subtle: "border-transparent bg-muted text-foreground",
  },
  success: {
    solid:
      "border-transparent bg-emerald-600 text-white dark:bg-emerald-500/15 dark:text-emerald-300",
    outline:
      "border-emerald-600 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-300",
    subtle:
      "border-transparent bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  warning: {
    solid:
      "border-transparent bg-amber-500 text-white dark:bg-amber-500/15 dark:text-amber-300",
    outline:
      "border-amber-500 text-amber-700 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-300",
    subtle:
      "border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  },
  error: {
    solid:
      "border-transparent bg-destructive text-destructive-foreground dark:bg-red-500/15 dark:text-red-300",
    outline:
      "border-destructive text-destructive dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-300",
    subtle:
      "border-transparent bg-destructive/15 text-destructive dark:bg-red-500/15 dark:text-red-300",
  },
};

const SIZE_STYLES = {
  small: "h-5 px-1.5 py-0 text-[10px]",
  medium: "h-5 px-1.5 py-0 text-[10px]",
  large: "px-2.5 py-1 text-sm",
};

export function Badge({
  label,
  children,
  variant = "primary",
  size = "medium",
  icon,
  onClick,
  removable = false,
  className,
  maxWidth,
  appearance,
  onRemove,
  isLoading = false,
}: BadgeProps) {
  const normalized = normalizeVariant(variant);
  const resolvedAppearance = appearance ?? (variant === "outline" ? "outline" : "solid");
  const content = label ?? children;
  const Root = onClick ? "button" : "span";

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    onClick?.();
  };

  const handleRemove = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onRemove?.();
  };

  return (
    <Root
      className={cn(
        "inline-flex w-fit max-w-full shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg]:pointer-events-none [&>svg]:size-3",
        VARIANT_STYLES[normalized][resolvedAppearance],
        SIZE_STYLES[size],
        onClick && "cursor-pointer",
        className,
      )}
      onClick={onClick ? handleClick : undefined}
      style={{ maxWidth }}
      type={onClick ? "button" : undefined}
    >
      {isLoading ? (
        <Loader2 aria-hidden="true" className="size-3 animate-spin" />
      ) : icon ? (
        <span className="shrink-0">{icon}</span>
      ) : null}
      <span className="min-w-0 truncate">{content}</span>
      {removable ? (
        <button
          className="-me-1 inline-flex size-4 items-center justify-center rounded-sm text-current/70 hover:bg-foreground/10 hover:text-current"
          onClick={handleRemove}
          type="button"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </Root>
  );
}

function normalizeVariant(variant: BadgeVariant): NormalizedBadgeVariant {
  if (variant === "danger") return "error";
  if (variant === "default" || variant === "outline") return "primary";
  return variant;
}
