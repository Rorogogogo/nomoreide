import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CornerDownLeft,
  Download,
  Loader2,
  PanelTop,
  Paperclip,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { hasAgentPath, readAgentPath } from "./drag-to-agent";
import { FilePicker } from "./file-picker";
import {
  type ApprovalPrompt,
  type ChatToolCall,
  type ChatTurn,
  useAgentChat,
} from "./use-agent-chat";

/**
 * Global AI chat dock. Pinned to the bottom of the viewport as a thin bar;
 * clicking expands it to fill the bottom half of the screen. Mounted once at
 * the app root so it's available on every page.
 */
export function AgentDock({ onOpenAgentPage }: { onOpenAgentPage?: () => void }) {
  const [open, setOpen] = useState(false);
  const { turns, streaming, error, configured, approvals, send, stop, clear, respond } =
    useAgentChat();
  const [draft, setDraft] = useState("");
  // `dragActive`: a path drag is happening *somewhere* (gentle invite).
  // `dragOver`: the cursor is over the dock specifically (about to drop).
  const [dragActive, setDragActive] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Append an absolute path to the draft (shared by drag-drop and the picker).
  function insertPath(path: string) {
    setOpen(true);
    setDraft((current) => (current.trim() ? `${current.replace(/\s*$/, "")} ${path} ` : `${path} `));
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Light up the dock the instant a draggable path is picked up anywhere in the
  // app, so the user can see where to aim before reaching the thin bottom bar.
  useEffect(() => {
    const onDragStart = (event: globalThis.DragEvent) => {
      if (event.dataTransfer && hasAgentPath(event.dataTransfer)) setDragActive(true);
    };
    const reset = () => {
      setDragActive(false);
      setDragOver(false);
    };
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", reset);
    document.addEventListener("drop", reset);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", reset);
      document.removeEventListener("drop", reset);
    };
  }, []);

  // Keep the transcript pinned to the latest content while streaming.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, open]);

  async function submit() {
    const text = draft;
    setDraft("");
    await send(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  // Accept files/folders/services dragged in from elsewhere in the app. The
  // dragged item carries its absolute path (see drag-to-agent.ts); we expand
  // the dock and append the path to the draft so the agent can act on it.
  function onDragOver(event: DragEvent) {
    if (!hasAgentPath(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!open) setOpen(true);
    setDragOver(true);
  }

  function onDragLeave(event: DragEvent) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  }

  function onDrop(event: DragEvent) {
    setDragOver(false);
    const path = readAgentPath(event.dataTransfer);
    if (!path) return;
    event.preventDefault();
    insertPath(path);
  }

  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-card/95 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur transition-[height] duration-200",
        open ? "h-[50vh]" : dragActive ? "h-12" : "h-9",
        dragActive && !dragOver && "border-primary/60 bg-primary/5",
        dragOver && "outline-dashed outline-2 -outline-offset-2 outline-primary/70",
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {open ? (
        <>
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <Sparkles className="size-4 text-primary" />
            <span className="text-sm font-medium">Agent</span>
            {streaming ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> thinking…
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {onOpenAgentPage ? (
                <Button
                  aria-label="Open agent page"
                  className="size-7"
                  onClick={onOpenAgentPage}
                  size="icon"
                  title="Open the full agent page"
                  type="button"
                  variant="ghost"
                >
                  <PanelTop />
                </Button>
              ) : null}
              <Button
                aria-label="Clear conversation"
                className="size-7"
                disabled={turns.length === 0}
                onClick={clear}
                size="icon"
                title="Clear conversation"
                type="button"
                variant="ghost"
              >
                <Trash2 />
              </Button>
              <Button
                aria-label="Collapse agent"
                className="size-7"
                onClick={() => setOpen(false)}
                size="icon"
                title="Collapse"
                type="button"
                variant="ghost"
              >
                <ChevronDown />
              </Button>
            </div>
          </header>

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3">
            {turns.length === 0 ? (
              <EmptyHint configured={configured} />
            ) : (
              turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
            )}
            {error ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            ) : null}
          </div>

          {approvals.length > 0 ? (
            <div className="shrink-0 space-y-1.5 border-t border-amber-400/40 bg-amber-50/60 px-3 py-2">
              {approvals.map((prompt) => (
                <ApprovalRow key={prompt.requestId} prompt={prompt} onRespond={respond} />
              ))}
            </div>
          ) : null}

          <div
            className={cn(
              "relative shrink-0 border-t border-border p-2 transition-colors",
              dragActive && "bg-primary/5",
            )}
          >
            {pickerOpen ? (
              <FilePicker
                onClose={() => setPickerOpen(false)}
                onPick={(path) => {
                  setPickerOpen(false);
                  insertPath(path);
                }}
              />
            ) : null}
            <div className="flex items-end gap-2">
              <Button
                aria-label="Attach a file or folder"
                className="size-9 shrink-0"
                disabled={configured === false}
                onClick={() => setPickerOpen(true)}
                size="icon"
                title="Attach a file or folder"
                type="button"
                variant={pickerOpen ? "secondary" : "outline"}
              >
                <Paperclip />
              </Button>
              <textarea
                ref={inputRef}
                className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={configured === false}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  configured === false
                    ? "Claude Code (`claude`) is not installed"
                    : "Ask Claude Code anything about this project…"
                }
                rows={1}
                value={draft}
              />
              {streaming ? (
                <Button onClick={stop} size="sm" type="button" variant="outline">
                  <Square /> Stop
                </Button>
              ) : (
                <Button
                  disabled={!draft.trim() || configured === false}
                  onClick={() => void submit()}
                  size="sm"
                  type="button"
                >
                  Send <CornerDownLeft />
                </Button>
              )}
            </div>
          </div>
        </>
      ) : (
        <button
          className={cn(
            "flex h-full w-full items-center gap-2 px-3 text-left text-sm hover:bg-muted/50",
            dragActive ? "font-medium text-primary" : "text-muted-foreground",
          )}
          onClick={() => setOpen(true)}
          type="button"
        >
          {dragActive ? (
            <>
              <Download className="size-4 animate-bounce text-primary" />
              <span>Drop here to add it to your message</span>
            </>
          ) : (
            <>
              <Sparkles className="size-4 text-primary" />
              <span>Ask the agent…</span>
              {streaming ? <Loader2 className="size-3.5 animate-spin" /> : null}
              <span className="ml-auto text-xs text-muted-foreground/70">click to expand</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

function EmptyHint({ configured }: { configured: boolean | null }) {
  if (configured === false) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        This dock runs the <code className="font-mono">claude</code> CLI. Install Claude Code (and{" "}
        <code className="font-mono">claude login</code>) so it's on NoMoreIDE's PATH, then reload.
      </div>
    );
  }
  return (
    <div className="text-xs text-muted-foreground">
      This is real Claude Code, running in your workspace with full tools — e.g. “restart the api
      and tail its logs”, “what changed in git and why?”, “fix the failing test”.
    </div>
  );
}

function TurnView({ turn }: { turn: ChatTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-sm text-primary-foreground">
          {turn.text}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {turn.tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
      {turn.text ? (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5 text-sm">
          {turn.text}
        </div>
      ) : null}
    </div>
  );
}

function ToolCard({ tool }: { tool: ChatToolCall }) {
  const arg = toolArgSummary(tool.input);
  return (
    <div
      className={cn(
        "inline-flex max-w-[85%] items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]",
        tool.isError
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-border bg-background text-muted-foreground",
      )}
    >
      {tool.status === "running" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Wrench className="size-3" />
      )}
      <span className="font-semibold">{tool.name}</span>
      {arg ? <span className="truncate">{arg}</span> : null}
    </div>
  );
}

function ApprovalRow({
  prompt,
  onRespond,
}: {
  prompt: ApprovalPrompt;
  onRespond: (requestId: string, decision: "allow" | "deny") => void;
}) {
  const arg = toolArgSummary(prompt.input).slice(0, 140);
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-400/50 bg-background/80 px-2 py-1.5 text-xs">
      <ShieldAlert className="size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <span className="font-mono font-semibold">{prompt.name}</span>
        {arg ? <span className="ml-1 truncate font-mono text-muted-foreground">{arg}</span> : null}
      </div>
      <Button
        className="h-7"
        onClick={() => onRespond(prompt.requestId, "deny")}
        size="sm"
        type="button"
        variant="outline"
      >
        <X /> Deny
      </Button>
      <Button
        className="h-7"
        onClick={() => onRespond(prompt.requestId, "allow")}
        size="sm"
        type="button"
      >
        <Check /> Allow
      </Button>
    </div>
  );
}

function toolArgSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const values = Object.values(input as Record<string, unknown>)
    .filter((value) => value !== undefined && value !== "")
    .map((value) => String(value));
  return values.join(" ");
}
