import { cn } from "@/lib/utils";

/**
 * The compact tab strip and its nested state filter.
 *
 * Both were hand-written per call site, which is how the GitHub page tabs, the
 * PR detail's Review/Diff pair, and the open/closed toggles drifted apart on
 * tab semantics and focus rings. One definition keeps them honest — and it
 * lives here rather than inside a feature because more than one now uses it.
 */

export type TabDef<T extends string> = { id: T; label: string };

/** Page-level tabs: selected reads `bg-foreground text-background`. */
export function TabStrip<T extends string>({
  ariaLabel,
  idPrefix,
  onSelect,
  tabs,
  value,
}: {
  ariaLabel: string;
  /** Namespaces the `<tab>`/`<tabpanel>` ids so nested strips never collide. */
  idPrefix: string;
  onSelect: (id: T) => void;
  tabs: readonly TabDef<T>[];
  value: T;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="flex max-w-full items-center gap-1 overflow-x-auto"
      role="tablist"
    >
      {tabs.map((tab) => (
        <button
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-selected={value === tab.id}
          className={cn(
            "shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === tab.id
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
          id={`${idPrefix}-tab-${tab.id}`}
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Nested state filter (open/closed, environment, …). Deliberately *not* the
 * tab treatment: it scopes the active view's list rather than switching views,
 * so it stays a quiet segmented control on a muted track instead of competing
 * with the page tabs.
 */
export function StateFilter<T extends string>({
  ariaLabel,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  onChange: (id: T) => void;
  options: readonly TabDef<T>[];
  value: T;
}) {
  return (
    <fieldset className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
      <legend className="sr-only">{ariaLabel}</legend>
      {options.map((option) => (
        <button
          aria-pressed={value === option.id}
          className={cn(
            "rounded px-2 py-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === option.id
              ? "bg-background text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={option.id}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
