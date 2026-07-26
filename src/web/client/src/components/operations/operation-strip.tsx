import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loading";
import { useOperations } from "@/components/operations/operation-context";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const REVEAL_DELAY_MS = 300;

export function OperationStrip() {
  const { operations } = useOperations();
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const t = useT();

  useEffect(() => {
    if (operations.length === 0) {
      setVisible(false);
      setOpen(false);
      return;
    }

    const earliestStart = Math.min(...operations.map(({ startedAt }) => startedAt));
    const remainingDelay = Math.max(
      0,
      REVEAL_DELAY_MS - (Date.now() - earliestStart),
    );
    if (remainingDelay === 0) {
      setVisible(true);
      return;
    }

    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), remainingDelay);
    return () => window.clearTimeout(timer);
  }, [operations]);

  if (!visible || operations.length === 0) return null;

  const multiple = operations.length > 1;
  const summary = multiple
    ? t("operation.multiple", { count: operations.length })
    : operations[0].label;

  return (
    <aside
      aria-live="polite"
      // Own margin/stacking rather than a wrapper, so nothing reserves space
      // for this strip on the pages where it never appears.
      className="relative z-30 mx-4 mt-2 shrink-0 rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-sm transition-all motion-reduce:transition-none"
      role="status"
    >
      <div className="flex min-h-7 items-center gap-2">
        <Spinner size="sm" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{summary}</span>
        {multiple ? (
          <Button
            aria-controls={detailsId}
            aria-expanded={open}
            aria-label={t(open ? "operation.hideDetails" : "operation.showDetails")}
            onClick={() => setOpen((current) => !current)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronDown
              className={cn(
                "transition-transform motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </Button>
        ) : null}
      </div>
      {multiple && open ? (
        <ul className="mt-2 space-y-1 border-t border-border pt-2" id={detailsId}>
          {operations.map((operation) => (
            <li className="flex items-center gap-2 text-xs text-muted-foreground" key={operation.id}>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
              <span className="truncate">{operation.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
