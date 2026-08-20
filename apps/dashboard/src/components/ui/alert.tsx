import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  // When an icon is passed as a direct <svg> child, lay the alert out as a
  // row (icon + content) like shadcn's Alert; plain-text alerts are untouched.
  "rounded-lg border p-4 text-sm has-[>svg]:flex has-[>svg]:items-start has-[>svg]:gap-2.5 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0", {
  variants: {
    variant: {
      default: "border-border bg-card text-card-foreground",
      muted: "border-border bg-muted text-muted-foreground",
      // Failures read as quiet inline notes, not red slabs: a neutral surface
      // with a single destructive hairline down the edge. The surrounding view
      // already says what failed, so the alert only has to carry the detail —
      // and that detail is usually a raw API string, hence the mono type.
      destructive:
        "break-words rounded-md border-border/60 border-l-2 border-l-destructive/50 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

export function Alert({ className, variant, ...props }: AlertProps) {
  return <div className={cn(alertVariants({ variant, className }))} {...props} />;
}

export function AlertTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn("mb-1 font-medium leading-none", className)} {...props} />;
}

export function AlertDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("leading-5", className)} {...props} />;
}
