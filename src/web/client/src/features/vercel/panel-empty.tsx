import type { ReactNode } from "react";

/**
 * What a tab shows when it has nothing to list.
 *
 * A lone grey sentence in the top-left corner of an otherwise blank page reads
 * as a failure — the eye cannot tell "this project has no environment
 * variables" from "this did not load". Pairing the sentence with the tab's own
 * icon says the panel arrived and the answer is simply zero.
 */
export function PanelEmpty({
  icon,
  children,
  action,
}: {
  icon: ReactNode;
  children: ReactNode;
  /** An add-style affordance, for tabs where "zero" is a state to act on. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-10">
      <span className="text-muted-foreground/25 [&>svg]:size-7">{icon}</span>
      <p className="text-[12px] text-muted-foreground">{children}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
