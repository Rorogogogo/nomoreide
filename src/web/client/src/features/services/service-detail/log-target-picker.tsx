import type { LogTarget } from "./use-logs";
import { useT } from "@/lib/i18n";

export interface LogOption {
  target: LogTarget;
  label: string;
  /** Optgroup heading this option appears under. */
  group: string;
}

function sameTarget(a: LogTarget, b: LogTarget): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/**
 * `<select>` that switches a log view between options (the live "dev" log and
 * saved sources). Shared by the per-service Logs tab and the multi-log panes.
 */
export function LogTargetPicker({
  options,
  target,
  onChange,
  className,
}: {
  options: LogOption[];
  target: LogTarget;
  onChange: (target: LogTarget) => void;
  className?: string;
}) {
  const t = useT();
  const selected = options.findIndex((option) => sameTarget(option.target, target));
  const groups = [...new Set(options.map((option) => option.group))];

  return (
    <select
      aria-label={t("services.logSource")}
      className={
        className ?? "h-8 max-w-44 rounded-md border border-border bg-background px-2 text-xs"
      }
      onChange={(event) => onChange(options[Number(event.target.value)].target)}
      value={String(selected)}
    >
      {groups.map((group) => (
        <optgroup key={group} label={group}>
          {options.map((option, index) =>
            option.group === group ? (
              <option key={`${option.group}:${option.label}`} value={String(index)}>
                {option.label}
              </option>
            ) : null,
          )}
        </optgroup>
      ))}
    </select>
  );
}
