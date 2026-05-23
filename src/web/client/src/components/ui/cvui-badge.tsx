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
      solid: "bg-[#11111198] text-white border border-transparent",
      outline: "border-2 border-[#11111198] text-[#11111198]",
      subtle: "bg-[#11111140] text-[#11111198] border border-transparent",
    },
    secondary: {
      solid: "bg-zinc-700 text-white border border-transparent",
      outline: "border-2 border-zinc-400 text-zinc-800 bg-white",
      subtle: "bg-zinc-100 text-zinc-800 border border-zinc-300",
    },
    success: {
      solid: "bg-emerald-600 text-white border border-transparent",
      outline: "border-2 border-emerald-600 text-emerald-700",
      subtle: "bg-emerald-100 text-emerald-700 border border-transparent",
    },
    warning: {
      solid: "bg-amber-500 text-white border border-transparent",
      outline: "border-2 border-amber-500 text-amber-700",
      subtle: "bg-amber-100 text-amber-700 border border-transparent",
    },
    error: {
      solid: "bg-destructive text-destructive-foreground border border-transparent",
      outline: "border-2 border-destructive text-destructive",
      subtle: "bg-destructive/20 text-destructive border border-transparent",
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
        backgroundColor: interactive && normalized === "primary" ? "#111111d1" : undefined,
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
          className="flex items-center justify-center rounded-md bg-[#11111198] p-1 opacity-70 hover:opacity-100"
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
