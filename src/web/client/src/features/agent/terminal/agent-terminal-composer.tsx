import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Link, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { onboardRepoPrompt } from "../prompts";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { FilePicker } from "../chat/file-picker";
import { useAgentDock } from "../chat/agent-context";

export function taskLabel(prompt: string, explicit?: string) {
  const source = explicit?.trim() || prompt.split(/\r?\n/).find((line) => line.trim())?.trim() || "Agent task";
  return source.length > 60 ? `${source.slice(0, 57).trimEnd()}…` : source;
}

export function AgentTerminalComposer({ onSubmitted }: { onSubmitted?: () => void }) {
  const { activeSource, clearSource, configured, createTask, creating, draft, focusNonce, insertPath, onboarding, provider, setDraft, setOnboarding } = useAgentDock();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const id = requestAnimationFrame(() => inputRef.current?.focus()); return () => cancelAnimationFrame(id); }, [focusNonce]);
  useLayoutEffect(() => { if (!inputRef.current) return; inputRef.current.style.height = "auto"; inputRef.current.style.height = `${inputRef.current.scrollHeight}px`; }, [draft]);

  async function submit(prompt = draft, label?: string) {
    if (!prompt.trim() || creating || configured !== true) return;
    const result = await createTask({ prompt, label: taskLabel(prompt, label ?? activeSource?.label), source: activeSource ?? undefined });
    if (!result) return;
    setDraft(""); clearSource(); setOnboarding(false); setUrl(""); onSubmitted?.();
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }
  const logo = provider?.id === "codex" ? <CodexLogo className="size-4" /> : <ClaudeLogo className="size-4" />;

  return <div className="flex h-full items-center justify-center overflow-auto p-6">
    <div className="w-full max-w-3xl">
      {configured === null ? <div className="mb-3 border-l-2 border-border pl-3 text-xs text-muted-foreground">Checking {provider?.label ?? "agent"} availability…</div> : null}
      {configured === false ? <div className="mb-3 border-l-2 border-amber-500/70 pl-3 text-xs text-muted-foreground"><span className="font-medium text-foreground">{provider?.label ?? "Agent"} is not installed.</span> {provider?.installHint}</div> : null}
      {activeSource ? <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="font-mono uppercase tracking-wide">Source</span><span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground">{activeSource.label}</span><button aria-label="Clear source" onClick={clearSource} type="button"><X className="size-3" /></button></div> : null}
      <div className="border border-border bg-card shadow-sm">
        {onboarding ? <div className="flex items-center gap-2 border-b border-border px-3 py-2"><Link className="size-4 text-muted-foreground" /><input aria-label="Repository URL" className="min-w-0 flex-1 bg-transparent text-sm outline-none" disabled={configured !== true} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repository" value={url} /><Button disabled={configured !== true || !url.trim() || !!creating} onClick={() => void submit(onboardRepoPrompt(url), `Onboard ${url}`)} size="sm">Onboard</Button></div> : null}
        <textarea aria-label="Agent task prompt" className="block max-h-40 min-h-20 w-full resize-none bg-transparent px-3 py-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground" disabled={configured !== true} onChange={(e) => setDraft(e.target.value)} onKeyDown={keyDown} placeholder="Describe the complete task…" ref={inputRef} rows={2} value={draft} />
        <div className="flex h-10 items-center gap-1 border-t border-border px-2">
          <span className="flex items-center gap-1.5 px-1 text-xs font-medium">{logo}{provider?.label ?? "Agent"}</span>
          <button aria-label="Attach file or folder" className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setPickerOpen((v) => !v)} type="button"><Paperclip className="size-3.5" /></button>
          <button className="px-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOnboarding(!onboarding)} type="button">Repository URL</button>
          <span className="flex-1" />
          <span className="hidden text-[10px] text-muted-foreground sm:inline">Shift+Enter for newline</span>
          <Button aria-label="Run agent task" className="size-7" disabled={configured !== true || !draft.trim() || !!creating} onClick={() => void submit()} size="icon"><ArrowUp /></Button>
        </div>
      </div>
      {pickerOpen ? <div className="relative mt-2"><FilePicker onClose={() => setPickerOpen(false)} onPick={(path) => { insertPath(path); setPickerOpen(false); }} /></div> : null}
    </div>
  </div>;
}
