import { Check } from "lucide-react";
import {
  ACCENT_PRESETS,
  accentSwatch,
  customHue,
  type AccentChoice,
} from "@/lib/accent";
import { useT, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SettingRow } from "./setting-controls";
import type { UiPreferences } from "./ui-preferences";

const HUE_GRADIENT =
  "linear-gradient(to right, hsl(0 70% 50%), hsl(60 70% 50%), hsl(120 70% 45%), " +
  "hsl(180 60% 45%), hsl(240 62% 55%), hsl(300 62% 52%), hsl(360 70% 50%))";

function Swatch({
  color,
  selected,
  title,
  rainbow,
  onClick,
}: {
  color: string;
  selected: boolean;
  title: string;
  rainbow?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={title}
      aria-pressed={selected}
      className={cn(
        "grid size-6 place-items-center rounded-full ring-offset-2 ring-offset-background transition",
        selected ? "ring-2 ring-ring" : "ring-1 ring-border hover:ring-foreground/40",
      )}
      onClick={onClick}
      style={{ background: rainbow ? HUE_GRADIENT : color }}
      title={title}
      type="button"
    >
      {selected ? <Check className="size-3.5 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]" /> : null}
    </button>
  );
}

/** Preset swatch row + a custom-hue swatch that reveals a hue slider. */
function AccentSwatches({
  value,
  onChange,
}: {
  value: AccentChoice;
  onChange: (value: AccentChoice) => void;
}) {
  const t = useT();
  const hue = customHue(value);
  const isCustom = hue !== null;
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap items-center justify-start gap-1.5 sm:justify-end">
        {ACCENT_PRESETS.map((preset) => (
          <Swatch
            color={preset.swatch}
            key={preset.id}
            onClick={() => onChange(preset.id)}
            selected={value === preset.id}
            title={t(preset.labelKey as TranslationKey)}
          />
        ))}
        <Swatch
          color={accentSwatch(isCustom ? value : "custom:265")}
          onClick={() => onChange(isCustom ? value : "custom:265")}
          rainbow={!isCustom}
          selected={isCustom}
          title={t("settingsHub.accent.custom")}
        />
      </div>
      {isCustom ? (
        <input
          aria-label={t("settingsHub.accent.hue")}
          className="h-2 w-44 cursor-pointer appearance-none rounded-full outline-none"
          max={359}
          min={0}
          onChange={(event) => onChange(`custom:${event.target.value}`)}
          style={{ background: HUE_GRADIENT }}
          type="range"
          value={hue ?? 0}
        />
      ) : null}
    </div>
  );
}

/**
 * Appearance-panel accent controls: a global accent picker plus, when a repo is
 * selected, a per-project override that re-tints the workbench on project switch.
 */
export function AccentSettings({
  ui,
  updateUi,
  activeProject,
}: {
  ui: UiPreferences;
  updateUi: (patch: Partial<Omit<UiPreferences, "version">>) => boolean;
  activeProject: { name: string; path: string } | null;
}) {
  const t = useT();
  const projectPath = activeProject?.path ?? null;
  const projectAccent = projectPath ? ui.projectAccents[projectPath] : undefined;
  const overriding = projectAccent !== undefined;

  const setProjectAccent = (next: AccentChoice | null) => {
    if (!projectPath) return;
    const accents = { ...ui.projectAccents };
    if (next === null) delete accents[projectPath];
    else accents[projectPath] = next;
    updateUi({ projectAccents: accents });
  };

  return (
    <>
      <SettingRow
        description={t("settingsHub.accent.description")}
        id="setting-accent"
        label={t("settingsHub.accent.label")}
      >
        <AccentSwatches onChange={(value) => updateUi({ accent: value })} value={ui.accent} />
      </SettingRow>

      {activeProject ? (
        <SettingRow
          description={t("settingsHub.accent.projectDescription")}
          id="setting-project-accent"
          label={t("settingsHub.accent.projectLabel", { name: activeProject.name })}
        >
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="inline-flex rounded-md border border-input p-0.5 text-xs">
              <button
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  overriding ? "text-muted-foreground hover:text-foreground" : "bg-muted font-medium text-foreground",
                )}
                onClick={() => setProjectAccent(null)}
                type="button"
              >
                {t("settingsHub.accent.useGlobal")}
              </button>
              <button
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  overriding ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setProjectAccent(projectAccent ?? ui.accent)}
                type="button"
              >
                {t("settingsHub.accent.override")}
              </button>
            </div>
            {overriding ? (
              <AccentSwatches onChange={setProjectAccent} value={projectAccent ?? ui.accent} />
            ) : null}
          </div>
        </SettingRow>
      ) : null}
    </>
  );
}
