import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppCredit } from "@/components/app-credit";
import { SETTINGS_CATEGORIES, categoryById, categoryDescKey, categoryLabelKey, type SettingsCategoryId } from "./settings-catalogue";
import { useT } from "@/lib/i18n";
import { SaveStatus } from "./setting-controls";
import type { SettingsSaveState } from "./settings-context";

function SettingsSearch({ search, onSearch }: { search: string; onSearch: (value: string) => void }) {
  const t = useT();
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input aria-label={t("settingsHub.searchAria")} className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-xs outline-none focus:ring-2 focus:ring-ring" onChange={(event) => onSearch(event.target.value)} placeholder={t("settingsHub.searchPlaceholder")} type="search" value={search} />
      {search ? <button aria-label={t("settingsHub.clearSearch")} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => onSearch("")} type="button"><X className="size-3" /></button> : null}
    </div>
  );
}

export function SettingsLayout({ selected, onSelect, search, onSearch, saveState, saveError, children }: { selected: SettingsCategoryId; onSelect: (id: SettingsCategoryId) => void; search: string; onSearch: (value: string) => void; saveState: SettingsSaveState; saveError: string | null; children: ReactNode }) {
  const t = useT();
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = categoryById(selected);
  const CurrentIcon = current.icon;
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (index + 1) % SETTINGS_CATEGORIES.length;
    if (event.key === "ArrowUp") next = (index - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = SETTINGS_CATEGORIES.length - 1;
    if (next === null) return;
    event.preventDefault();
    const category = SETTINGS_CATEGORIES[next];
    onSelect(category.id);
    buttonRefs.current[next]?.focus();
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      {/* No header row of its own: the shell breadcrumb already names this
          page, so search rides at the top of the category column it filters. */}
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2 md:hidden">
        <select aria-label={t("settingsHub.category")} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" id="settings-category-select" onChange={(event) => onSelect(event.target.value as SettingsCategoryId)} value={selected}>{SETTINGS_CATEGORIES.map((category) => <option key={category.id} value={category.id}>{t(categoryLabelKey(category.id))}</option>)}</select>
        <SettingsSearch onSearch={onSearch} search={search} />
        <SaveStatus error={saveError} state={saveState} />
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="relative hidden w-56 shrink-0 flex-col border-r border-border bg-muted/20 p-2 md:flex">
          <div className="mb-2">
            <SettingsSearch onSearch={onSearch} search={search} />
          </div>
          <nav aria-label={t("settingsHub.categoriesAria")} className="space-y-0.5">
            {SETTINGS_CATEGORIES.map((category, index) => {
              const Icon = category.icon;
              const active = selected === category.id;
              return <button aria-current={active ? "page" : undefined} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-muted hover:text-foreground")} key={category.id} onClick={() => onSelect(category.id)} onKeyDown={(event) => navigate(event, index)} ref={(node) => { buttonRefs.current[index] = node; }} tabIndex={active ? 0 : -1} type="button"><Icon className="size-3.5" /><span>{t(categoryLabelKey(category.id))}</span></button>;
            })}
          </nav>
          {/* Transient, so it floats at the foot of the column instead of
              reserving a permanent empty row above the categories. */}
          <div className="absolute inset-x-2 bottom-2">
            <SaveStatus error={saveError} state={saveState} />
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-3 py-4 sm:px-6 sm:py-6">
            {!search ? <div className="mb-4"><div className="flex items-center gap-2"><CurrentIcon className="size-4 text-muted-foreground" /><h2 className="text-base font-semibold">{t(categoryLabelKey(current.id))}</h2></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{t(categoryDescKey(current.id))}</p></div> : null}
            {children}
            {/* Moved off the sidebar footer so the rail is navigation only. */}
            <footer className="mt-8 border-t border-border/60 pt-3">
              <AppCredit />
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
