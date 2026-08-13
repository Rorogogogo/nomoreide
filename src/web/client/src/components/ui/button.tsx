import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Spinner } from "@/components/ui/loading";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "border-border bg-background hover:bg-muted",
        ghost: "hover:bg-muted",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        success: "bg-emerald-600 text-white hover:bg-emerald-700",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-xs",
        icon: "size-9 p-0",
        "icon-sm": "size-7 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  loadingLabel?: React.ReactNode;
  /** React 19 passes ref as a plain prop; it rides `...props` onto <button>. */
  ref?: React.Ref<HTMLButtonElement>;
}

export function Button({
  children,
  className,
  disabled,
  loading = false,
  loadingLabel,
  size,
  variant,
  ...props
}: ButtonProps) {
  const iconOnly = size === "icon" || size === "icon-sm";

  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
    >
      {/* The wrapper exists only to group the spinner with the label while
          loading. Outside that state it must not form a box of its own, or it
          collapses every child into a single grid/flex item and breaks buttons
          whose className drives their own layout (e.g. the sidebar nav's
          grid-cols-[48px_minmax(0,1fr)] icon/label split). */}
      <span
        className={
          loading
            ? "inline-flex items-center justify-center gap-2"
            : "contents"
        }
      >
        {loading ? (
          <>
            <Spinner size="sm" />
            {iconOnly ? null : (loadingLabel ?? children)}
          </>
        ) : (
          children
        )}
      </span>
    </button>
  );
}

export { buttonVariants };
