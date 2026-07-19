import { AnimatePresence, motion } from "framer-motion";
import type { IncidentLevel } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export function IncidentFilterPanel({
  activeCount,
  levels,
  onClear,
  onToggleLevel,
  onToggleService,
  open,
  query,
  reduceMotion,
  selectedLevels,
  selectedServices,
  services,
}: {
  activeCount: number;
  levels: IncidentLevel[];
  onClear: () => void;
  onToggleLevel: (level: IncidentLevel) => void;
  onToggleService: (service: string) => void;
  open: boolean;
  query: string;
  reduceMotion: boolean | null;
  selectedLevels: IncidentLevel[];
  selectedServices: string[];
  services: string[];
}) {
  const t = useT();
  const transition = reduceMotion ? { duration: 0 } : { duration: 0.16 };

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          animate={{ height: "auto", opacity: 1 }}
          className="mt-3 grid gap-4 overflow-hidden rounded-lg border border-border bg-background p-3 md:grid-cols-2 lg:w-[280px] lg:grid-cols-1"
          exit={{ height: 0, opacity: 0 }}
          initial={{ height: 0, opacity: 0 }}
          transition={transition}
        >
          <FilterGroup
            format={(level) =>
              t(level === "error" ? "errors.level.error" : "errors.level.warning")
            }
            label={t("errors.filterSeverity")}
            onToggle={onToggleLevel}
            options={levels}
            selected={selectedLevels}
          />
          <FilterGroup
            format={(service) => service}
            label={t("errors.filterService")}
            onToggle={onToggleService}
            options={services}
            selected={selectedServices}
          />
          <Button
            disabled={activeCount === 0 && !query}
            onClick={onClear}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("errors.clearFilters")}
          </Button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function FilterGroup<T extends string>({
  format,
  label,
  onToggle,
  options,
  selected,
}: {
  format: (value: T) => string;
  label: string;
  onToggle: (value: T) => void;
  options: T[];
  selected: T[];
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const pressed = selected.includes(option);
          return (
            <Button
              aria-pressed={pressed}
              key={option}
              onClick={() => onToggle(option)}
              size="sm"
              type="button"
              variant={pressed ? "secondary" : "outline"}
            >
              {format(option)}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}
