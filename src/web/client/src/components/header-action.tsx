import { cn } from "@/lib/utils";

export function headerActionClassName(className?: string) {
  return cn(
    "group/header-action inline-flex h-8 w-8 items-center overflow-hidden rounded-md text-sm font-medium text-muted-foreground transition-[width,background-color,color] duration-200 hover:w-24 hover:bg-muted hover:text-foreground focus:w-24 focus:bg-muted focus:text-foreground focus-visible:w-24 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
}

export function headerActionIconClassName(className?: string) {
  return cn(
    "flex size-8 shrink-0 items-center justify-center [&_svg]:size-4 [&_svg]:shrink-0",
    className,
  );
}

export function headerActionLabelClassName(className?: string) {
  return cn(
    "max-w-0 overflow-hidden whitespace-nowrap text-left opacity-0 transition-[max-width,opacity] duration-200 group-hover/header-action:max-w-20 group-hover/header-action:opacity-100 group-focus/header-action:max-w-20 group-focus/header-action:opacity-100",
    className,
  );
}
