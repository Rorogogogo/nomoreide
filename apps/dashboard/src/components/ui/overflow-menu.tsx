import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
}

/**
 * A minimal kebab (⋯) overflow menu. The list is portalled to <body> and
 * fixed-positioned under the trigger so it never gets clipped by a scrolling
 * container (e.g. a data grid). Closes on outside-click, Escape, or scroll.
 */
export function OverflowMenu({
  items,
  label,
  className,
}: {
  items: OverflowMenuItem[];
  label?: string;
  className?: string;
}) {
  const t = useT();
  const resolvedLabel = label ?? t("common.moreActions");
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, right: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggle() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Capture-phase: catch scrolls on any ancestor, not just window.
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        aria-label={resolvedLabel}
        className={cn(
          "flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all duration-150 hover:bg-muted hover:text-foreground group-hover:opacity-100",
          open && "opacity-100",
          className,
        )}
        onClick={toggle}
        ref={triggerRef}
        title={resolvedLabel}
        type="button"
      >
        <MoreHorizontal className="size-3.5" />
      </button>
      {open
        ? createPortal(
            <div
              className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-border bg-card p-1 shadow-md"
              ref={menuRef}
              style={{ top: coords.top, right: coords.right }}
            >
              {items.map((item) => (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
                  key={item.label}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  type="button"
                >
                  {item.icon ? <span className="text-muted-foreground">{item.icon}</span> : null}
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
