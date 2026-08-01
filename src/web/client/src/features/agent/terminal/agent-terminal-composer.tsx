import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Link, Paperclip, Sparkles, SquareTerminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { onboardRepoPrompt } from "../prompts";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { FilePicker } from "../chat/file-picker";
import { useAgentDock } from "../chat/agent-context";
import { AgentCapabilityStrip } from "./agent-capability-strip";
import type { AgentCapabilities } from "./agent-capability-data";
import type { AgentDockPage } from "./agent-terminal-dock";
import { useT } from "@/lib/i18n";

const CHIP = "flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export function taskLabel(prompt: string, explicit?: string) {
  const source = explicit?.trim() || prompt.split(/\r?\n/).find((line) => line.trim())?.trim() || "Agent task";
  return source.length > 60 ? `${source.slice(0, 57).trimEnd()}…` : source;
}

export function AgentTerminalComposer({ capabilities, onNavigate, onShellMode, shellMode = false }: { capabilities?: AgentCapabilities; onNavigate?: (page: AgentDockPage) => void; onShellMode?: (shell: boolean) => void; shellMode?: boolean }) {
  const t = useT();
  const { activeSource, clearOneTimeSkill, clearSource, configured, consumeOneTimeSkill, createShellTask, createTask, creating, draft, focusNonce, insertPath, insertPrompt, onboarding, pendingOneTimeSkill, provider, providers, selectProvider, setDraft, setOnboarding } = useAgentDock();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const id = requestAnimationFrame(() => { const input = inputRef.current; if (!input) return; input.focus(); const end = input.value.length; input.setSelectionRange(end, end); }); return () => cancelAnimationFrame(id); }, [focusNonce]);
  useLayoutEffect(() => { if (!inputRef.current) return; inputRef.current.style.height = "auto"; inputRef.current.style.height = `${inputRef.current.scrollHeight}px`; }, [draft]);

  // A shell needs no prompt and no installed agent — Enter on an empty draft
  // just opens one, and anything typed runs as its first command.
  const blocked = Boolean(creating) || (shellMode ? false : !draft.trim() || configured !== true);
  async function submit(prompt = draft, label?: string) {
    if (creating) return;
    if (shellMode) {
      const result = await createShellTask(prompt);
      if (!result) return;
      setDraft(""); clearSource(); setUrl("");
      return;
    }
    if (!prompt.trim() || configured !== true) return;
    const oneTimeSkill = pendingOneTimeSkill ?? undefined;
    // Creating a foreground task selects its tab, which is what leaves compose.
    const result = await createTask({ prompt, label: taskLabel(prompt, label ?? activeSource?.label), oneTimeSkill, source: activeSource ?? undefined });
    if (!result) return;
    if (oneTimeSkill) consumeOneTimeSkill(oneTimeSkill);
    setDraft(""); clearSource(); setOnboarding(false); setUrl("");
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }

  return <div className="flex h-full items-center justify-center overflow-auto p-6">
    <div className="w-full max-w-3xl">
      {!shellMode && configured === null ? <div className="mb-3 border-l-2 border-border pl-3 text-xs text-muted-foreground">{t("dock.checkingAvailability", { name: provider?.label ?? "agent" })}</div> : null}
      {!shellMode && configured === false ? <div className="mb-3 border-l-2 border-amber-500/70 pl-3 text-xs text-muted-foreground"><span className="font-medium text-foreground">{t("dock.notInstalled", { name: provider?.label ?? "Agent" })}</span> {provider?.installHint}</div> : null}
      {activeSource ? <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="font-mono uppercase tracking-wide">{t("dock.sourceLabel")}</span><span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground">{activeSource.label}</span><button aria-label={t("dock.clearSourceAria")} onClick={clearSource} type="button"><X className="size-3" /></button></div> : null}
      {!shellMode && pendingOneTimeSkill ? <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Sparkles className="size-3" /><span className="font-mono uppercase tracking-wide">{t("dock.skillTemp")}</span><span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground">{pendingOneTimeSkill.name}</span><button aria-label={t("dock.skillTempClear", { name: pendingOneTimeSkill.name })} onClick={clearOneTimeSkill} type="button"><X className="size-3" /></button><span>{t("dock.skillTempHint")}</span></div> : null}
      <div className="border border-border bg-card shadow-sm">
        {onboarding && !shellMode ? <div className="flex items-center gap-2 border-b border-border px-3 py-2"><Link className="size-4 text-muted-foreground" /><input aria-label={t("dock.repoUrlAria")} className="min-w-0 flex-1 bg-transparent text-sm outline-none" disabled={configured !== true} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repository" value={url} /><Button disabled={configured !== true || !url.trim() || !!creating} onClick={() => void submit(onboardRepoPrompt(url), `Onboard ${url}`)} size="sm">{t("dock.onboard")}</Button></div> : null}
        <textarea aria-label={shellMode ? t("dock.shellCommandAria") : t("dock.promptAria")} className={cn("block max-h-40 min-h-20 w-full resize-none bg-transparent px-3 py-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground", shellMode && "font-mono")} disabled={!shellMode && configured !== true} onChange={(e) => setDraft(e.target.value)} onKeyDown={keyDown} placeholder={shellMode ? t("dock.shellPlaceholder") : t("dock.promptPlaceholder")} ref={inputRef} rows={2} value={draft} />
        <div className="flex h-10 items-center gap-1 border-t border-border px-2">
          {/* Shell sits beside the agents as a peer choice, but it is not an
              agent provider — picking it never touches the persisted one. */}
          <fieldset aria-label={t("dock.providerAria")} className="flex shrink-0 items-center gap-0.5">
            {providers.map((p) => { const ProviderLogo = p.id === "codex" ? CodexLogo : ClaudeLogo; const selected = !shellMode && (provider?.id ?? "claude") === p.id; return <button aria-label={p.label} aria-pressed={selected} className={cn(CHIP, selected && "bg-muted text-foreground")} disabled={!p.configured} key={p.id} onClick={() => { onShellMode?.(false); void selectProvider(p.id); }} title={p.configured ? p.label : `${p.label}${t("dock.notInstalledSuffix")} — ${p.installHint}`} type="button"><ProviderLogo className="size-3.5" />{selected ? <span>{p.label}</span> : null}</button>; })}
            <button aria-label={t("dock.shell")} aria-pressed={shellMode} className={cn(CHIP, shellMode && "bg-muted text-foreground")} onClick={() => onShellMode?.(true)} title={t("dock.shellTitle")} type="button"><SquareTerminal className="size-3.5" />{shellMode ? <span>{t("dock.shell")}</span> : null}</button>
          </fieldset>
          <button aria-label={t("dock.attachAria")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setPickerOpen((v) => !v)} type="button"><Paperclip className="size-3.5" /></button>
          {shellMode ? null : <button className="px-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOnboarding(!onboarding)} type="button">{t("dock.repoUrlToggle")}</button>}
          <span className="flex-1" />
          <span className="hidden text-[10px] text-muted-foreground sm:inline">{shellMode ? t("dock.shellEnterHint") : t("dock.shiftEnterHint")}</span>
          <Button aria-label={shellMode ? t("dock.openShellAria") : t("dock.runAria")} className="size-7" disabled={blocked} onClick={() => void submit()} size="icon"><ArrowUp /></Button>
        </div>
      </div>
      {capabilities ? <AgentCapabilityStrip capabilities={capabilities} onInsert={insertPrompt} onNavigate={onNavigate} providerLabel={provider?.label} /> : null}
      {pickerOpen ? <div className="relative mt-2"><FilePicker onClose={() => setPickerOpen(false)} onPick={(path) => { insertPath(path); setPickerOpen(false); }} /></div> : null}
    </div>
  </div>;
}
