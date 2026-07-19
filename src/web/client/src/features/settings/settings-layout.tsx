import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Search, Settings, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SETTINGS_CATEGORIES, categoryById, type SettingsCategoryId } from "./settings-catalogue";
import { SaveStatus } from "./setting-controls";
import type { SettingsSaveState } from "./settings-context";

export function SettingsLayout({ selected, onSelect, search, onSearch, saveState, saveError, children }: { selected: SettingsCategoryId; onSelect: (id: SettingsCategoryId) => void; search: string; onSearch: (value: string) => void; saveState: SettingsSaveState; saveError: string | null; children: ReactNode }) {
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
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2"><Settings className="size-4 text-muted-foreground" /><span className="text-sm font-semibold">Settings</span></div>
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input aria-label="Search settings" className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-xs outline-none focus:ring-2 focus:ring-ring" onChange={(event) => onSearch(event.target.value)} placeholder="Search settings" type="search" value={search} />
          {search ? <button aria-label="Clear settings search" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => onSearch("")} type="button"><X className="size-3" /></button> : null}
        </div>
        <SaveStatus error={saveError} state={saveState} />
      </header>
      <div className="border-b border-border px-3 py-2 md:hidden">
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="settings-category-select">Category</label>
        <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" id="settings-category-select" onChange={(event) => onSelect(event.target.value as SettingsCategoryId)} value={selected}>{SETTINGS_CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 border-r border-border bg-muted/20 p-2 md:block">
          <nav aria-label="Settings categories" className="space-y-0.5">
            {SETTINGS_CATEGORIES.map((category, index) => {
              const Icon = category.icon;
              const active = selected === category.id;
              return <button aria-current={active ? "page" : undefined} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-muted hover:text-foreground")} key={category.id} onClick={() => onSelect(category.id)} onKeyDown={(event) => navigate(event, index)} ref={(node) => { buttonRefs.current[index] = node; }} type="button"><Icon className="size-3.5" /><span>{category.label}</span></button>;
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-3 py-4 sm:px-6 sm:py-6">
            {!search ? <div className="mb-4"><div className="flex items-center gap-2"><CurrentIcon className="size-4 text-muted-foreground" /><h2 className="text-base font-semibold">{current.label}</h2></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{current.description}</p></div> : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
