import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Link, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { onboardRepoPrompt } from "../prompts";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { FilePicker } from "../chat/file-picker";
import { useAgentDock } from "../chat/agent-context";
import { AgentCapabilityStrip } from "./agent-capability-strip";
import type { AgentCapabilities } from "./agent-capability-data";
import type { AgentDockPage } from "./agent-terminal-dock";
import { useT } from "@/lib/i18n";

export function taskLabel(prompt: string, explicit?: string) {
  const source = explicit?.trim() || prompt.split(/\r?\n/).find((line) => line.trim())?.trim() || "Agent task";
  return source.length > 60 ? `${source.slice(0, 57).trimEnd()}…` : source;
}

export function AgentTerminalComposer({ capabilities, onNavigate, onSubmitted }: { capabilities?: AgentCapabilities; onNavigate?: (page: AgentDockPage) => void; onSubmitted?: () => void }) {
  const t = useT();
  const { activeSource, clearSource, configured, createTask, creating, draft, focusNonce, insertPath, insertPrompt, onboarding, provider, providers, selectProvider, setDraft, setOnboarding } = useAgentDock();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const id = requestAnimationFrame(() => { const input = inputRef.current; if (!input) return; input.focus(); const end = input.value.length; input.setSelectionRange(end, end); }); return () => cancelAnimationFrame(id); }, [focusNonce]);
  useLayoutEffect(() => { if (!inputRef.current) return; inputRef.current.style.height = "auto"; inputRef.current.style.height = `${inputRef.current.scrollHeight}px`; }, [draft]);

  async function submit(prompt = draft, label?: string) {
    if (!prompt.trim() || creating || configured !== true) return;
    const result = await createTask({ prompt, label: taskLabel(prompt, label ?? activeSource?.label), source: activeSource ?? undefined });
    if (!result) return;
    setDraft(""); clearSource(); setOnboarding(false); setUrl(""); onSubmitted?.();
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }

  return <div className="flex h-full items-center justify-center overflow-auto p-6">
    <div className="w-full max-w-3xl">
      {configured === null ? <div className="mb-3 border-l-2 border-border pl-3 text-xs text-muted-foreground">{t("dock.checkingAvailability", { name: provider?.label ?? "agent" })}</div> : null}
      {configured === false ? <div className="mb-3 border-l-2 border-amber-500/70 pl-3 text-xs text-muted-foreground"><span className="font-medium text-foreground">{t("dock.notInstalled", { name: provider?.label ?? "Agent" })}</span> {provider?.installHint}</div> : null}
      {activeSource ? <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="font-mono uppercase tracking-wide">{t("dock.sourceLabel")}</span><span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground">{activeSource.label}</span><button aria-label={t("dock.clearSourceAria")} onClick={clearSource} type="button"><X className="size-3" /></button></div> : null}
      <div className="border border-border bg-card shadow-sm">
        {onboarding ? <div className="flex items-center gap-2 border-b border-border px-3 py-2"><Link className="size-4 text-muted-foreground" /><input aria-label={t("dock.repoUrlAria")} className="min-w-0 flex-1 bg-transparent text-sm outline-none" disabled={configured !== true} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repository" value={url} /><Button disabled={configured !== true || !url.trim() || !!creating} onClick={() => void submit(onboardRepoPrompt(url), `Onboard ${url}`)} size="sm">{t("dock.onboard")}</Button></div> : null}
        <textarea aria-label={t("dock.promptAria")} className="block max-h-40 min-h-20 w-full resize-none bg-transparent px-3 py-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground" disabled={configured !== true} onChange={(e) => setDraft(e.target.value)} onKeyDown={keyDown} placeholder={t("dock.promptPlaceholder")} ref={inputRef} rows={2} value={draft} />
        <div className="flex h-10 items-center gap-1 border-t border-border px-2">
          <fieldset aria-label={t("dock.providerAria")} className="flex shrink-0 items-center gap-0.5">{providers.map((p) => { const ProviderLogo = p.id === "codex" ? CodexLogo : ClaudeLogo; const selected = (provider?.id ?? "claude") === p.id; return <button aria-label={p.label} aria-pressed={selected} className={`flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 ${selected ? "bg-muted text-foreground" : ""}`} disabled={!p.configured} key={p.id} onClick={() => void selectProvider(p.id)} title={p.configured ? p.label : `${p.label}${t("dock.notInstalledSuffix")} — ${p.installHint}`} type="button"><ProviderLogo className="size-3.5" />{selected ? <span>{p.label}</span> : null}</button>; })}</fieldset>
          <button aria-label={t("dock.attachAria")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setPickerOpen((v) => !v)} type="button"><Paperclip className="size-3.5" /></button>
          <button className="px-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOnboarding(!onboarding)} type="button">{t("dock.repoUrlToggle")}</button>
          <span className="flex-1" />
          <span className="hidden text-[10px] text-muted-foreground sm:inline">{t("dock.shiftEnterHint")}</span>
          <Button aria-label={t("dock.runAria")} className="size-7" disabled={configured !== true || !draft.trim() || !!creating} onClick={() => void submit()} size="icon"><ArrowUp /></Button>
        </div>
      </div>
      {capabilities ? <AgentCapabilityStrip capabilities={capabilities} onInsert={insertPrompt} onNavigate={onNavigate} providerLabel={provider?.label} /> : null}
      {pickerOpen ? <div className="relative mt-2"><FilePicker onClose={() => setPickerOpen(false)} onPick={(path) => { insertPath(path); setPickerOpen(false); }} /></div> : null}
    </div>
  </div>;
}
