"use client";

import type React from "react";
import { motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

type BadgeVariant = "primary" | "secondary" | "success" | "warning" | "error" | "danger" | "default" | "outline";
type BadgeAppearance = "solid" | "outline" | "subtle";

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

export const Badge = ({
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
}: BadgeProps) => {
  const normalized = normalizeVariant(variant);
  const resolvedAppearance = appearance ?? (variant === "outline" ? "outline" : "solid");
  const content = label ?? children;
  const interactive = Boolean(onClick);

  const variantStyles = {
    primary: {
      solid: "border border-transparent bg-primary text-primary-foreground dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:text-zinc-100",
      outline: "border-2 border-primary/60 text-foreground dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:text-zinc-100",
      subtle: "border border-transparent bg-primary/15 text-foreground dark:border-zinc-700/70 dark:bg-zinc-900/70 dark:text-zinc-200",
    },
    secondary: {
      solid: "border border-transparent bg-secondary text-secondary-foreground dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:text-zinc-200",
      outline: "border-2 border-border bg-card text-foreground dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:text-zinc-200",
      subtle: "border border-border bg-muted text-foreground dark:border-zinc-700/70 dark:bg-zinc-900/70 dark:text-zinc-200",
    },
    success: {
      solid: "border border-transparent bg-emerald-600 text-white dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300",
      outline: "border-2 border-emerald-600 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-300",
      subtle: "border border-transparent bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-500/15 dark:text-emerald-300",
    },
    warning: {
      solid: "border border-transparent bg-amber-500 text-white dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-300",
      outline: "border-2 border-amber-500 text-amber-700 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-300",
      subtle: "border border-transparent bg-amber-500/15 text-amber-700 dark:border-amber-400/25 dark:bg-amber-500/15 dark:text-amber-300",
    },
    error: {
      solid: "border border-transparent bg-destructive text-destructive-foreground dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-300",
      outline: "border-2 border-destructive text-destructive dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-300",
      subtle: "border border-transparent bg-destructive/20 text-destructive dark:border-red-400/25 dark:bg-red-500/15 dark:text-red-300",
    },
  } satisfies Record<Exclude<BadgeVariant, "danger" | "default" | "outline">, Record<BadgeAppearance, string>>;

  const sizeStyles = {
    small: "text-xs px-2 py-1",
    medium: "text-xs px-2.5 py-1",
    large: "text-sm px-3 py-1.5",
  };

  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onClick?.();
  };

  const handleRemove = (event: React.MouseEvent) => {
    event.stopPropagation();
    onRemove?.();
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 8, filter: "blur(8px)" }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.32, ease: "easeInOut", type: "spring" }}
      whileHover={{
        scale: interactive ? 1.04 : 1,
        transition: {
          duration: 0.2,
          ease: "easeInOut",
          type: "spring",
        },
      }}
      onClick={handleClick}
      style={{ maxWidth }}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-lg font-medium shadow-[0_0_16px_rgba(0,0,0,0.14)] backdrop-blur-sm",
        variantStyles[normalized][resolvedAppearance],
        sizeStyles[size],
        interactive && "cursor-pointer",
        className,
      )}
    >
      {isLoading ? (
        <motion.div
          animate={{ rotate: 360 }}
          transition={{
            duration: 1,
            ease: "linear",
            repeat: Infinity,
          }}
          className="flex-shrink-0"
        >
          <Loader2 className="size-3.5" />
        </motion.div>
      ) : (
        icon && <span className="flex-shrink-0">{icon}</span>
      )}
      <span className="min-w-0 truncate">{content}</span>
      {removable && (
        <motion.button
          initial={{ opacity: 0, scale: 0.95, filter: "blur(8px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          whileHover={{
            scale: 1.1,
            opacity: 1,
            transition: {
              duration: 0.2,
              ease: "easeInOut",
              type: "spring",
            },
          }}
          className="flex items-center justify-center rounded-md bg-foreground/15 p-1 opacity-70 hover:opacity-100"
          onClick={handleRemove}
          type="button"
        >
          <X className="size-3.5" />
        </motion.button>
      )}
    </motion.div>
  );
};

function normalizeVariant(variant: BadgeVariant): Exclude<BadgeVariant, "danger" | "default" | "outline"> {
  if (variant === "danger") return "error";
  if (variant === "default" || variant === "outline") return "primary";
  return variant;
}
