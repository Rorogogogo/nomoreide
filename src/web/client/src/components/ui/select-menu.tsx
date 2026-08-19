import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectMenuOption {
  value: string;
  label: string;
  /** Muted trailing text — a format, a count, a branch, whatever qualifies the label. */
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * A one-of-many picker in the app's own menu style — the popover the project
 * and branch breadcrumbs already use, wrapped as a control that returns a
 * value.
 *
 * It exists because the alternative is a bare `<select>`, and a `<select>`
 * renders its list with the OS, not with us: on macOS that is a grey system
 * popup that ignores the theme, the accent, the mono type a file path wants,
 * and cannot show a hint column. The rest of the dashboard picks things from a
 * bordered card with a checkmark on the current row, so a native list is the
 * one control that looks like it belongs to a different app.
 *
 * Behaviour follows the native control it replaces, because that is what makes
 * it a fair swap: type-ahead is the only thing deliberately left out — the
 * lists this opens on are short, and the ones that aren't should be a filtered
 * dialog rather than a longer menu.
 */
export function SelectMenu({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder,
  className,
  mono = false,
  disabled = false,
}: {
  options: SelectMenuOption[];
  value: string | null;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Trigger text when nothing is selected yet. */
  placeholder?: string;
  className?: string;
  /** Render labels in the mono face — paths, ids, anything read character by character. */
  mono?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, minWidth: 0 });
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  function place() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setCoords({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
  }

  function toggle() {
    if (disabled) return;
    place();
    // Keyboard arrows start from the current row, as they do in a `<select>`.
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen((current) => !current);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    onChange(option.value);
  }

  function step(delta: number) {
    if (options.length === 0) return;
    setActive((current) => {
      let next = current;
      // Skip disabled rows rather than landing on one and going silent; the
      // loop is bounded by the list length, so an all-disabled list stays put.
      for (let hop = 0; hop < options.length; hop += 1) {
        next = (next + delta + options.length) % options.length;
        if (!options[next]?.disabled) return next;
      }
      return current;
    });
  }

  /**
   * Measure again after the menu exists: a list wider than the trigger, or one
   * near the bottom of the window, has to be pulled back inside the viewport,
   * and only the mounted node knows how big it is.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!menu || !rect) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const flip = rect.bottom + 4 + height > window.innerHeight && rect.top - 4 - height > 0;
    setCoords((current) => ({
      ...current,
      left,
      top: flip ? rect.top - 4 - height : rect.bottom + 4,
    }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    // Fixed coordinates are taken once from the trigger, so any scroll behind
    // the menu strands it — but the menu's own list scrolls too, and that
    // scroll moves nothing it is anchored to.
    function onScroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={cn(
          "flex h-6 min-w-0 items-center gap-1.5 rounded border border-border/60 bg-background px-1.5 text-left text-[11px] transition-colors hover:bg-muted disabled:opacity-60",
          open && "bg-muted",
          className,
        )}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onKeyDown}
        ref={triggerRef}
        title={selected?.label ?? placeholder}
        type="button"
      >
        {selected?.icon ? <span className="shrink-0">{selected.icon}</span> : null}
        <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono")}>
          {selected?.label ?? placeholder ?? ""}
        </span>
        {selected?.hint ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{selected.hint}</span>
        ) : null}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open
        ? createPortal(
            <div
              aria-label={ariaLabel}
              className="fixed z-[100] flex max-h-80 flex-col overflow-y-auto rounded-md border border-border bg-card p-1 shadow-md"
              ref={menuRef}
              role="listbox"
              style={{ top: coords.top, left: coords.left, minWidth: coords.minWidth }}
            >
              {options.map((option, index) => (
                <button
                  aria-selected={option.value === value}
                  className={cn(
                    "flex w-full shrink-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                    index === active && !option.disabled && "bg-muted",
                    option.value === value && "bg-muted/60",
                    option.disabled
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-muted",
                  )}
                  disabled={option.disabled}
                  key={option.value}
                  onClick={() => choose(index)}
                  onMouseEnter={() => setActive(index)}
                  role="option"
                  title={option.label}
                  type="button"
                >
                  {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
                  <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono")}>
                    {option.label}
                  </span>
                  {option.hint ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {option.hint}
                    </span>
                  ) : null}
                  <Check
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground",
                      option.value === value ? "" : "invisible",
                    )}
                  />
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
