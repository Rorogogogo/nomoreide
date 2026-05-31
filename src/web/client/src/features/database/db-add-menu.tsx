import { useEffect, useRef, useState } from "react";
import { Database, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The Database page "+" entry point — mirrors the Services add menu: a manual
 * "Add connection" dialog, or "Add with AI" which hands setup to the dock.
 */
export function DbAddMenu({
  onAddManual,
  onAddWithAi,
}: {
  onAddManual: () => void;
  onAddWithAi: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="relative" ref={containerRef}>
      <Button
        aria-label="Add database connection"
        onClick={() => setOpen((value) => !value)}
        size="sm"
        type="button"
      >
        <Plus className="size-3.5" />
        Add
      </Button>

      {open ? (
        <div className="absolute right-0 top-9 z-50 w-56 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
            onClick={() => choose(onAddManual)}
            type="button"
          >
            <Database className="size-3.5 text-muted-foreground" />
            Add connection
          </button>
          <button
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
            onClick={() => choose(onAddWithAi)}
            type="button"
          >
            <Sparkles className="size-3.5 text-muted-foreground" />
            Add with AI
          </button>
        </div>
      ) : null}
    </div>
  );
}
