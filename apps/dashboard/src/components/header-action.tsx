import { cn } from "@/lib/utils";

export function headerActionClassName(className?: string) {
  return cn(
    "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
}

export function headerActionIconClassName(className?: string) {
  return cn(
    "flex size-7 shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:shrink-0",
    className,
  );
}
