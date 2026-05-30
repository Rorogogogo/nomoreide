import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CornerDownLeft,
  Download,
  GitBranch,
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
import { useToasts } from "@/components/ui/toast";
import { postForm, type AgentChatProviderInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { onboardRepoPrompt } from "../prompts";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { useAgentDock } from "./agent-context";
import { hasAgentPath, readAgentPath } from "./drag-to-agent";
import { FilePicker } from "./file-picker";
import { OptionList, parseAgentMessage, ServiceActions } from "./message-options";
import { ThinkingIndicator, useSmoothText } from "./streaming-ui";
import type { ApprovalPrompt, ChatToolCall, ChatTurn } from "./use-agent-chat";

/**
 * Global AI chat dock. Pinned to the bottom of the viewport as a thin bar;
 * clicking expands it to fill the bottom half of the screen. Mounted once at
 * the app root so it's available on every page.
 */
export function AgentDock({
  onOpenAgentPage,
  onOpenService,
}: {
  onOpenAgentPage?: () => void;
  /** Navigate to the Services page and focus a service (for the chat shortcut). */
  onOpenService?: (name: string) => void;
}) {
  const { error: showErrorToast, success: showSuccessToast } = useToasts();
  const {
    turns,
    streaming,
    error,
    configured,
    provider,
    approvals,
    send,
    stop,
    clear,
    respond,
    open,
    setOpen,
    draft,
    setDraft,
    insertPath,
    activeSource,
    clearSource,
    focusNonce,
    sendToAgent,
    onboarding,
    setOnboarding,
  } = useAgentDock();
  const [onboardUrl, setOnboardUrl] = useState("");
  // `dragActive`: a path drag is happening *somewhere* (gentle invite).
  // `dragOver`: the cursor is over the dock specifically (about to drop).
  const [dragActive, setDragActive] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  // Re-focus the input when the dock opens or something stages a draft/path.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, focusNonce]);

  // Collapse the dock when the user interacts anywhere outside it, so the
  // expanded panel gets out of the way the moment attention moves elsewhere.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (dockRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, setOpen]);

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

  // Follow new content only while the user is already at the bottom. A plain
  // scroll listener flips this off the instant they scroll up, so streaming
  // never fights them — they can read back freely while the agent works.
  const stickRef = useRef(true);
  function onTranscriptScroll() {
    const node = scrollRef.current;
    if (node) stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [turns, open]);

  async function submit() {
    const text = draft;
    setDraft("");
    stickRef.current = true; // sending always snaps the view back to the latest
    await send(text);
  }

  // Hand a repo URL to the agent to onboard end-to-end. The only manual step is
  // the URL itself; everything after is pure agent (clone, detect, install, run).
  function onboardRepo(url: string) {
    if (!url.trim()) return;
    setDraft("");
    setOnboarding(false);
    setOnboardUrl("");
    stickRef.current = true;
    sendToAgent({
      prompt: onboardRepoPrompt(url),
      source: { type: "repo-onboard", label: "Onboard repo" },
    });
  }

  // Clicking an agent-offered option just sends it as the next reply.
  function choose(value: string) {
    stickRef.current = true;
    void send(value);
  }

  // Start a service the agent just registered, straight from the chat.
  async function startService(name: string) {
    try {
      await postForm(`/api/services/${encodeURIComponent(name)}/start`, {});
      showSuccessToast(`Starting ${name}…`);
    } catch (caught) {
      showErrorToast(caught instanceof Error ? caught.message : `Could not start ${name}.`);
    }
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
      ref={dockRef}
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
            <ProviderLogo provider={provider} className="size-4 text-primary" />
            <span className="text-sm font-medium">{provider?.label ?? "Agent"}</span>
            {activeSource ? (
              <span className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                <Sparkles className="size-3" />
                <span className="max-w-40 truncate">{activeSource.label}</span>
                <button
                  aria-label="Clear source"
                  className="opacity-60 hover:opacity-100"
                  onClick={clearSource}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </span>
            ) : null}
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

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3"
            onScroll={onTranscriptScroll}
          >
            {turns.length === 0 ? (
              <EmptyHint
                configured={configured}
                provider={provider}
                onOnboard={() => setOnboarding(true)}
              />
            ) : (
              turns.map((turn, index) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  streaming={streaming && index === turns.length - 1}
                  isLast={index === turns.length - 1}
                  onChoose={choose}
                  onStartService={startService}
                  onOpenService={onOpenService}
                />
              ))
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
            {/* The one manual step: paste a repo URL. After submit it's pure agent. */}
            {onboarding ? (
              <form
                className="mb-2 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  onboardRepo(onboardUrl);
                }}
              >
                <GitBranch className="size-4 shrink-0 text-primary" />
                <input
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onChange={(event) => setOnboardUrl(event.target.value)}
                  placeholder="Paste a repo URL — e.g. https://github.com/owner/repo"
                  value={onboardUrl}
                />
                <Button disabled={!onboardUrl.trim()} size="sm" type="submit">
                  Onboard
                </Button>
                <Button
                  aria-label="Cancel onboarding"
                  className="size-7"
                  onClick={() => {
                    setOnboarding(false);
                    setOnboardUrl("");
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X />
                </Button>
              </form>
            ) : looksLikeGitUrl(draft) && !streaming ? (
              <button
                className="mb-2 flex w-full items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/10"
                onClick={() => onboardRepo(draft)}
                type="button"
              >
                <GitBranch className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  Onboard <span className="font-mono">{draft.trim()}</span> as a service
                </span>
                <CornerDownLeft className="size-3.5 shrink-0 opacity-60" />
              </button>
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
                    ? `${provider?.label ?? "Agent"} (\`${provider?.commandName ?? "agent"}\`) is not installed`
                    : `Ask ${provider?.label ?? "the agent"} anything about this project...`
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
              <ProviderLogo provider={provider} className="size-4 text-primary" />
              {streaming ? (
                <span className="flex items-center gap-2 text-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> {provider?.label ?? "Agent"} is
                  thinking…
                </span>
              ) : (
                <span>Ask {provider?.label ?? "the agent"}...</span>
              )}
              <span className="ml-auto text-xs text-muted-foreground/70">click to expand</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

function ProviderLogo({
  provider,
  className,
}: {
  provider: AgentChatProviderInfo | null;
  className?: string;
}) {
  if (provider?.id === "claude") return <ClaudeLogo className={className} />;
  if (provider?.id === "codex") return <CodexLogo className={className} />;
  return <Sparkles className={className} />;
}

function EmptyHint({
  configured,
  provider,
  onOnboard,
}: {
  configured: boolean | null;
  provider: AgentChatProviderInfo | null;
  onOnboard: () => void;
}) {
  if (configured === false) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        This dock runs the <code className="font-mono">{provider?.commandName ?? "agent"}</code>{" "}
        CLI. {provider?.installHint ?? "Install the active agent CLI, then reload."}
      </div>
    );
  }
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        {provider?.intro ??
          "This is the active agent, running in your workspace with full tools - e.g. \"restart the api and tail its logs\", \"what changed in git and why?\", \"fix the failing test\"."}
      </p>
      <button
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-2.5 py-1 text-primary transition-colors hover:bg-primary/10"
        onClick={onOnboard}
        type="button"
      >
        <GitBranch className="size-3.5" />
        Onboard a repo from a URL
      </button>
    </div>
  );
}

const GIT_URL = /^(?:https?:\/\/|git@|ssh:\/\/)\S+$/i;

/** A pasted line that looks like a clonable Git repo (not just any URL). */
function looksLikeGitUrl(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes("\n") || trimmed.includes(" ") || !GIT_URL.test(trimmed)) return false;
  return /github\.com|gitlab\.|bitbucket\.|\.git$/i.test(trimmed);
}

function TurnView({
  turn,
  streaming,
  isLast,
  onChoose,
  onStartService,
  onOpenService,
}: {
  turn: ChatTurn;
  streaming: boolean;
  isLast: boolean;
  onChoose: (value: string) => void;
  onStartService: (name: string) => void;
  onOpenService?: (name: string) => void;
}) {
  // Smooth the live assistant turn; user turns and finished turns render as-is
  // (their text arrives complete, so the typewriter has nothing to catch up on).
  const text = useSmoothText(turn.text);

  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-sm text-primary-foreground">
          {turn.text}
        </div>
      </div>
    );
  }

  // Pull agent-offered choices / service shortcuts out of the prose into UI.
  const { body, options, service } = parseAgentMessage(text);
  return (
    <div className="space-y-1.5">
      {turn.tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
      {body ? (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5 text-sm">
          {body}
        </div>
      ) : null}
      {/* Only the latest turn's options stay clickable (older ones are history). */}
      {options.length > 0 && isLast && !streaming ? (
        <OptionList options={options} onChoose={onChoose} />
      ) : null}
      {service && !streaming ? (
        <ServiceActions service={service} onStart={onStartService} onOpen={onOpenService} />
      ) : null}
      {streaming && !body ? <ThinkingIndicator /> : null}
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
