import { useEffect, useRef, useState } from "react";
import { Database, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

const MENU_WIDTH = 224;
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * The Database page "+" entry point — mirrors the Services add menu: a manual
 * "Add connection" dialog, or "Add with AI" which hands setup to the dock.
 */
export function DbAddMenu({
  onAddManual,
  onAddWithAi,
  compact = false,
}: {
  onAddManual: () => void;
  onAddWithAi: () => void;
  compact?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      const trigger = triggerRef.current;
      if (trigger) setPosition(menuPosition(trigger));
    }
    function closeOnOutsideClick(event: MouseEvent) {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="relative" ref={containerRef}>
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("database.addMenuAria")}
        className={compact ? "size-6" : undefined}
        onClick={(event) => {
          if (open) {
            setOpen(false);
          } else {
            setPosition(menuPosition(event.currentTarget));
            setOpen(true);
          }
        }}
        ref={triggerRef}
        size={compact ? "icon" : "sm"}
        title={compact ? t("database.addMenuAria") : undefined}
        type="button"
        variant={compact ? "ghost" : "default"}
      >
        <Plus className="size-3.5" />
        {compact ? null : t("common.add")}
      </Button>

      {open ? (
        <div
          className="fixed z-50 w-56 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          role="menu"
          style={position}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
            onClick={() => choose(onAddManual)}
            role="menuitem"
            type="button"
          >
            <Database className="size-3.5 text-muted-foreground" />
            {t("database.addConnection")}
          </button>
          <button
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
            onClick={() => choose(onAddWithAi)}
            role="menuitem"
            type="button"
          >
            <Sparkles className="size-3.5 text-muted-foreground" />
            {t("database.addWithAi")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function menuPosition(trigger: HTMLElement): { left: number; top: number } {
  const rect = trigger.getBoundingClientRect();
  return {
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
    ),
    top: rect.bottom + MENU_GAP,
  };
}
