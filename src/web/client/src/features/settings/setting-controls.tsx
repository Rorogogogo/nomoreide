import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { SettingsSaveState } from "./settings-context";

export function ScopeBadge({ scope }: { scope: "global" | "project" }) {
  return (
    <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide", scope === "project" ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-border bg-muted/60 text-muted-foreground") }>
      {scope === "project" ? "Current project" : "Global"}
    </span>
  );
}

export function SaveStatus({ state, error }: { state: SettingsSaveState; error: string | null }) {
  if (state === "idle") return null;
  return (
    <div aria-live="polite" className={cn("flex items-center gap-1.5 text-xs", state === "error" ? "text-destructive" : "text-muted-foreground")}>
      {state === "saving" ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {state === "saved" ? <Check className="size-3.5 text-emerald-600" /> : null}
      {state === "error" ? <AlertCircle className="size-3.5" /> : null}
      <span>{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : error}</span>
    </div>
  );
}

export function SettingRow({ id, label, description, children, disabled = false }: { id: string; label: string; description: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={cn("grid gap-3 border-b border-border/50 px-4 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center", disabled && "opacity-55")}>
      <div className="min-w-0">
        <label className="text-sm font-medium" htmlFor={id}>{label}</label>
        <p className="mt-0.5 max-w-xl text-xs leading-5 text-muted-foreground" id={`${id}-description`}>{description}</p>
      </div>
      <div className="min-w-0 sm:justify-self-end">{children}</div>
    </div>
  );
}

export function SettingToggle({ id, label, description, checked, onChange, disabled = false }: { id: string; label: string; description: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <SettingRow description={description} disabled={disabled} id={id} label={label}>
      <input aria-describedby={`${id}-description`} checked={checked} className="size-4 accent-foreground" disabled={disabled} id={id} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
    </SettingRow>
  );
}

export function SettingSelect({ id, label, description, value, options, onChange, disabled = false }: { id: string; label: string; description: string; value: string; options: Array<{ value: string; label: string; disabled?: boolean }>; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <SettingRow description={description} disabled={disabled} id={id} label={label}>
      <select aria-describedby={`${id}-description`} className="h-8 min-w-36 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={disabled} id={id} onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map((option) => <option disabled={option.disabled} key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </SettingRow>
  );
}

export function SettingNumberInput({ id, label, description, value, min, max, onSave, disabled = false }: { id: string; label: string; description: string; value: number; min: number; max: number; onSave: (value: number) => void | Promise<void>; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(String(value)), [value]);
  function save() {
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      setError(`Enter a value from ${min} to ${max}`);
      return;
    }
    setError(null);
    void onSave(parsed);
  }
  return (
    <SettingRow description={description} disabled={disabled} id={id} label={label}>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <div className="flex items-center gap-2">
          <Input aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`} className="h-8 w-24 font-mono text-xs" disabled={disabled} id={id} max={max} min={min} onChange={(event) => setDraft(event.target.value)} type="number" value={draft} />
          <Button aria-label={`Save ${label}`} disabled={disabled} onClick={save} size="sm" type="button" variant="outline">Save</Button>
        </div>
        {error ? <span className="text-[11px] text-destructive" id={`${id}-error`}>{error}</span> : null}
      </div>
    </SettingRow>
  );
}

export function ManagementRow({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="flex items-center justify-between gap-4 border-b border-border/50 px-4 py-3.5 last:border-b-0"><div><div className="text-sm font-medium">{title}</div><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p></div>{action}</div>;
}

export function UnavailableSetting({ children }: { children: ReactNode }) {
  return <div className="border border-dashed border-border bg-muted/30 px-4 py-3 text-xs leading-5 text-muted-foreground">{children}</div>;
}
