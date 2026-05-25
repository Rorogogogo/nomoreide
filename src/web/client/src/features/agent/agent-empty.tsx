import type { ReactNode } from "react";

/** Centered placeholder for panels that have no data for the selected agent yet. */
export function AgentNotice({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
      <div className="text-muted-foreground/70">{icon}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? (
        <p className="max-w-sm text-xs text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}
