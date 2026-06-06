import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
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
import { postForm, type AgentChatProviderInfo, type DashboardData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { GitSituationBanner } from "../../git/git-situation-banner";
import { onboardRepoPrompt } from "../prompts";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { useAgentDock } from "./agent-context";
import { hasAgentPath, readAgentPath } from "./drag-to-agent";
import { FilePicker } from "./file-picker";
import { OptionList, parseAgentMessage, ServiceActions, SqlWriteAction } from "./message-options";
import { ChatMarkdown } from "./chat-markdown";
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
  onOpenSqlConsole,
  git,
  onGitRefresh,
}: {
  onOpenAgentPage?: () => void;
  /** Navigate to the Services page and focus a service (for the chat shortcut). */
  onOpenService?: (name: string) => void;
  /** Stage an agent-drafted write into the Database page's SQL console. */
  onOpenSqlConsole?: (connection: string, sql: string) => void;
  /** Current git slice of the dashboard — powers the contextual situation strip. */
  git?: DashboardData["git"];
  /** Reload dashboard data after a git mutation triggered from the dock. */
  onGitRefresh?: () => void;
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
    stickNonce,
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
  // Drag-to-resize: `dockHeight` is the user-chosen height in px (null = the
  // default 50vh). `resizing` suppresses the height transition mid-drag so the
  // edge tracks the cursor 1:1 instead of easing behind it.
  const [dockHeight, setDockHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onboardingInputRef = useRef<HTMLInputElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  // Re-focus the input when the dock opens or something stages a draft/path.
  // We poll a few frames because the textarea may mount behind the dock's open
  // animation, and its controlled value lands a tick after the effect fires —
  // placing the caret too early would leave it at line 1 instead of the end.
  useEffect(() => {
    if (!open || onboarding) return;
    let frame = 0;
    let tries = 0;
    const place = () => {
      const input = inputRef.current;
      // Wait until the element exists and carries the staged draft.
      if (!input || (draft && input.value !== draft)) {
        if (tries++ < 10) frame = requestAnimationFrame(place);
        return;
      }
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
      input.scrollTop = input.scrollHeight;
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
    // `draft` is read inside but intentionally excluded from deps: focusNonce
    // bumps in the same batch as setDraft, so this re-runs with the fresh value
    // on every staged action — adding draft here would yank the caret to the
    // end on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusNonce, onboarding]);

  // Auto-grow the textarea with its content: reset to the 1-row min, then size
  // to fit. CSS `max-h-32` caps it and lets it scroll beyond a few lines.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (!open || !onboarding) return;
    requestAnimationFrame(() => onboardingInputRef.current?.focus());
  }, [open, onboarding]);

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

  // Any send (dock input or a feature action) re-arms stick-to-bottom and snaps
  // to the newest turn — even if the user had scrolled up in a long transcript.
  // rAF waits for the new turn (and the dock's open animation) to lay out first.
  useEffect(() => {
    stickRef.current = true;
    const node = scrollRef.current;
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [stickNonce]);

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
      label: `Onboard and run this repo: ${url}`,
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

  // Grab the top edge to resize the dock. The dock is anchored to the bottom, so
  // its height is `viewport height - cursor Y`; we clamp it to a sane band and
  // track the pointer until release (pointer capture survives leaving the strip).
  function onResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (!open) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    const minHeight = 160;
    const maxHeight = window.innerHeight - 48;
    function onMove(moveEvent: PointerEvent) {
      const next = window.innerHeight - moveEvent.clientY;
      setDockHeight(Math.max(minHeight, Math.min(maxHeight, next)));
    }
    function onUp() {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      ref={dockRef}
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-card/95 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur",
        resizing ? "select-none" : "transition-[height] duration-200",
        open ? (dockHeight === null ? "h-[50vh]" : "") : dragActive ? "h-12" : "h-9",
        dragActive && !dragOver && "border-primary/60 bg-primary/5",
        dragOver && "outline-dashed outline-2 -outline-offset-2 outline-primary/70",
      )}
      style={open && dockHeight !== null ? { height: dockHeight } : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {open ? (
        <>
          {/* Drag the top edge up/down to resize the dock; double-click to reset. */}
          <div
            aria-hidden
            className="absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize"
            onDoubleClick={() => setDockHeight(null)}
            onPointerDown={onResizeStart}
          />
          {/* No top bar — the centered column keeps the middle clear, so the
              status and controls live in the empty left/right gutters instead,
              giving the conversation the full dock height. The wrapper ignores
              pointer events so the middle stays grabbable for the resize strip. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 px-2 pt-1.5">
            <div className="pointer-events-auto flex items-center gap-2">
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
            </div>
            <div className="pointer-events-auto flex items-center gap-1">
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
          </div>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto px-3 py-3"
            onScroll={onTranscriptScroll}
          >
            {/* Centered reading column so replies wrap at a comfortable width
                instead of stretching across the full (wide) dock — ChatGPT-style. */}
            <div className="mx-auto w-full max-w-4xl space-y-3">
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
                    onOpenSqlConsole={onOpenSqlConsole}
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
          </div>

          {approvals.length > 0 ? (
            <div className="shrink-0 space-y-1.5 border-t border-amber-500/25 bg-amber-500/[0.04] px-3 py-2">
              {approvals.map((prompt) => (
                <ApprovalRow key={prompt.requestId} prompt={prompt} onRespond={respond} />
              ))}
            </div>
          ) : null}

          <div
            className={cn(
              "relative shrink-0 p-2 transition-colors",
              dragActive && "bg-primary/5",
            )}
          >
            {git ? <GitSituationBanner git={git} onRefresh={onGitRefresh} /> : null}
            {pickerOpen ? (
              <FilePicker
                onClose={() => setPickerOpen(false)}
                onPick={(path) => {
                  setPickerOpen(false);
                  insertPath(path);
                }}
              />
            ) : null}
            {/* Match the transcript's reading column so the input lines up with it. */}
            <div className="mx-auto w-full max-w-4xl">
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
                  ref={onboardingInputRef}
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
            {/* One unified pill: attach + textarea + circular send, with the
                whole container reacting to hover/focus instead of three boxes. */}
            <div className="flex items-end gap-1.5 rounded-2xl border border-border bg-background px-1.5 py-1.5 shadow-sm transition-colors hover:border-foreground/25 focus-within:border-foreground/40 focus-within:ring-1 focus-within:ring-ring">
              <Button
                aria-label="Attach a file or folder"
                className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                disabled={configured === false}
                onClick={() => setPickerOpen(true)}
                size="icon"
                title="Attach a file or folder"
                type="button"
                variant={pickerOpen ? "secondary" : "ghost"}
              >
                <Paperclip />
              </Button>
              <textarea
                ref={inputRef}
                className="max-h-32 min-h-8 flex-1 resize-none self-center overflow-y-auto bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
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
                <Button
                  aria-label="Stop generating"
                  className="size-8 shrink-0 rounded-full"
                  onClick={stop}
                  size="icon"
                  title="Stop"
                  type="button"
                  variant="secondary"
                >
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button
                  aria-label="Send message"
                  className="size-8 shrink-0 rounded-full"
                  disabled={!draft.trim() || configured === false}
                  onClick={() => void submit()}
                  size="icon"
                  title="Send"
                  type="button"
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
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

/**
 * A user turn. When the turn carries a short `label` (a long preset prompt was
 * sent), show the label by default with a toggle to reveal the full text —
 * keeps the conversation tidy without hiding what was actually sent.
 */
function UserBubble({ turn }: { turn: ChatTurn }) {
  const [expanded, setExpanded] = useState(false);
  const hasPreset = Boolean(turn.label) && turn.label !== turn.text;
  const shown = hasPreset && !expanded ? (turn.label as string) : turn.text;
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-0.5">
        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-muted px-3.5 py-2 text-sm text-foreground">
          {shown}
        </div>
        {hasPreset ? (
          <button
            className="flex items-center gap-0.5 px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            {expanded ? "Hide full prompt" : "Show full prompt"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TurnView({
  turn,
  streaming,
  isLast,
  onChoose,
  onStartService,
  onOpenService,
  onOpenSqlConsole,
}: {
  turn: ChatTurn;
  streaming: boolean;
  isLast: boolean;
  onChoose: (value: string) => void;
  onStartService: (name: string) => void;
  onOpenService?: (name: string) => void;
  onOpenSqlConsole?: (connection: string, sql: string) => void;
}) {
  // Smooth the live assistant turn; user turns and finished turns render as-is
  // (their text arrives complete, so the typewriter has nothing to catch up on).
  const text = useSmoothText(turn.text);

  if (turn.role === "user") {
    return <UserBubble turn={turn} />;
  }

  // Pull agent-offered choices / service shortcuts / staged writes out of prose.
  const { body, options, service, sqlWrite } = parseAgentMessage(text);
  return (
    <div className="space-y-1.5">
      {turn.tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
      {body ? (
        <div className="break-words px-0.5 text-sm text-foreground">
          <ChatMarkdown content={body} />
        </div>
      ) : null}
      {/* Only the latest turn's options stay clickable (older ones are history). */}
      {options.length > 0 && isLast && !streaming ? (
        <OptionList options={options} onChoose={onChoose} />
      ) : null}
      {service && !streaming ? (
        <ServiceActions service={service} onStart={onStartService} onOpen={onOpenService} />
      ) : null}
      {sqlWrite && onOpenSqlConsole && !streaming ? (
        <SqlWriteAction proposal={sqlWrite} onOpen={onOpenSqlConsole} />
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
    <div className="flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
        <ShieldAlert className="size-4" />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400/90">
          Permission needed
        </div>
        <div className="truncate font-mono text-[11px]">
          <span className="font-semibold text-foreground">{prompt.name}</span>
          {arg ? <span className="ml-1 text-muted-foreground">{arg}</span> : null}
        </div>
      </div>
      <Button
        className="h-7 gap-1 text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
        onClick={() => onRespond(prompt.requestId, "deny")}
        size="sm"
        type="button"
        variant="outline"
      >
        <X className="size-3.5" /> Deny
      </Button>
      <Button
        className="h-7 gap-1"
        onClick={() => onRespond(prompt.requestId, "allow")}
        size="sm"
        type="button"
      >
        <Check className="size-3.5" /> Allow
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
