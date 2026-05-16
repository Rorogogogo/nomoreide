import * as React from "react";
import { cn } from "@/lib/utils";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("grid gap-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}
