import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { History, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import type { AgentTranscriptInfo, AgentTranscriptScope } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { ClaudeLogo, CodexLogo } from "../agent-logos";

type ProviderFilter = "all" | AgentTranscriptInfo["provider"];

function transcriptTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function transcriptProject(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || cwd;
}

export function AgentConversationPicker({
  error,
  loading,
  onLoad,
  onResume,
  provider,
  transcripts,
}: {
  error: string | null;
  loading: boolean;
  onLoad: (scope?: AgentTranscriptScope) => Promise<AgentTranscriptInfo[]>;
  onResume: (transcript: AgentTranscriptInfo) => Promise<unknown>;
  provider?: AgentTranscriptInfo["provider"];
  transcripts: AgentTranscriptInfo[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(
    provider ?? "all",
  );
  const [placement, setPlacement] = useState({
    above: false,
    maxHeight: 560,
    offset: 36,
    right: 8,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filteredTranscripts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return transcripts.filter((transcript) => {
      if (
        providerFilter !== "all" &&
        transcript.provider !== providerFilter
      ) {
        return false;
      }
      if (!normalizedQuery) return true;
      const providerName = transcript.provider === "codex" ? "codex" : "claude code";
      return `${transcript.title} ${providerName} ${transcriptProject(transcript.cwd)}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [providerFilter, query, transcripts]);
  const providerCounts = useMemo(
    () => ({
      all: transcripts.length,
      claude: transcripts.filter((transcript) => transcript.provider === "claude").length,
      codex: transcripts.filter((transcript) => transcript.provider === "codex").length,
    }),
    [transcripts],
  );

  const updatePlacement = useCallback(() => {
    const trigger = rootRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const popover = popoverRef.current?.getBoundingClientRect();
    const gap = 4;
    const viewportMargin = 8;
    const roomAbove = Math.max(0, trigger.top - gap - viewportMargin);
    const roomBelow = Math.max(
      0,
      window.innerHeight - trigger.bottom - gap - viewportMargin,
    );
    const above = Boolean(popover && popover.height > roomBelow);
    const desiredRight = window.innerWidth - trigger.right;
    const maximumRight = Math.max(
      viewportMargin,
      window.innerWidth - (popover?.width ?? 0) - viewportMargin,
    );
    setPlacement({
      above,
      maxHeight: Math.min(560, above ? roomAbove : roomBelow),
      offset: above
        ? window.innerHeight - trigger.top + gap
        : trigger.bottom + gap,
      right: Math.min(
        Math.max(viewportMargin, desiredRight),
        maximumRight,
      ),
    });
  }, []);

  useEffect(() => {
    if (open) {
      setProviderFilter(provider ?? "all");
      void onLoad("all");
      window.requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setQuery("");
    }
  }, [open, onLoad, provider]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open, updatePlacement]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  const resume = async (transcript: AgentTranscriptInfo) => {
    setOpen(false);
    await onResume(transcript);
  };

  const popover = open
    ? createPortal(
        <section
          aria-label={t("dock.conversations")}
          className="fixed z-[100] flex w-[min(28rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-2xl"
          ref={popoverRef}
          role="dialog"
          style={{
            maxHeight: placement.maxHeight,
            right: placement.right,
            ...(placement.above
              ? { bottom: placement.offset }
              : { top: placement.offset }),
          }}
        >
          <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border bg-muted/20 px-3">
            <History
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold tracking-tight">
                {t("dock.conversations")}
              </h2>
              <p className="truncate text-[11px] leading-4 text-muted-foreground">
                {t("dock.conversationsScope")}
              </p>
            </div>
            <button
              aria-label={t("dock.refreshConversations")}
              className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
              disabled={loading}
              onClick={() => void onLoad("all")}
              type="button"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
          </header>
          <div className="shrink-0 border-b border-border bg-background/70 p-2">
            <div className="flex h-8 items-center gap-2 rounded border border-border bg-background px-2 text-muted-foreground shadow-sm focus-within:border-primary/50 focus-within:text-foreground">
              <Search className="size-3.5 shrink-0" />
              <input
                aria-label={t("dock.searchConversations")}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("dock.searchConversationsPlaceholder")}
                ref={searchRef}
                type="search"
                value={query}
              />
              {query ? (
                <button
                  aria-label={t("dock.clearConversationSearch")}
                  className="grid size-5 shrink-0 place-items-center rounded-sm hover:bg-muted"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
            <nav
              aria-label={t("dock.conversationProviderFilter")}
              className="mt-1.5 flex items-center gap-1"
            >
              {(["all", "claude", "codex"] as const).map((filter) => (
                <button
                  aria-pressed={providerFilter === filter}
                  className={cn(
                    "flex h-6 items-center gap-1 rounded-sm px-2 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground",
                    providerFilter === filter &&
                      "bg-foreground text-background hover:bg-foreground hover:text-background",
                  )}
                  key={filter}
                  onClick={() => setProviderFilter(filter)}
                  type="button"
                >
                  <span>{t(`dock.conversationProvider.${filter}`)}</span>
                  <span className="font-mono tabular-nums opacity-70">
                    {providerCounts[filter]}
                  </span>
                </button>
              ))}
            </nav>
          </div>
          <section
            aria-label={t("dock.conversationResults")}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 [scrollbar-gutter:stable]"
            data-conversation-scroll
          >
            {loading && transcripts.length === 0 ? (
              <div className="flex h-28 items-center justify-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                {t("dock.loadingConversations")}
              </div>
            ) : error ? (
              <div className="m-1 rounded border border-destructive/30 bg-destructive/5 px-3 py-4 text-xs text-destructive">
                {error}
              </div>
            ) : transcripts.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <History className="mx-auto mb-2 size-5 text-muted-foreground/50" />
                <p className="text-xs font-medium">{t("dock.noConversations")}</p>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  {t("dock.noConversationsHint")}
                </p>
              </div>
            ) : filteredTranscripts.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Search className="mx-auto mb-2 size-5 text-muted-foreground/50" />
                <p className="text-xs font-medium">
                  {t("dock.noMatchingConversations")}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  {t("dock.noMatchingConversationsHint")}
                </p>
              </div>
            ) : (
              filteredTranscripts.map((transcript) => {
                const ProviderLogo =
                  transcript.provider === "codex" ? CodexLogo : ClaudeLogo;
                return (
                  <button
                    className="group flex w-full items-start gap-3 rounded px-2.5 py-2.5 text-left hover:bg-muted/70 focus-visible:bg-muted focus-visible:outline-none"
                    key={`${transcript.provider}:${transcript.id}`}
                    onClick={() => void resume(transcript)}
                    type="button"
                  >
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded border border-border bg-background group-hover:border-primary/40">
                      <ProviderLogo className="size-3.5 text-muted-foreground group-hover:text-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-xs font-medium leading-4">
                        {transcript.title}
                      </span>
                      <span className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                        <span className="uppercase tracking-wide">
                          {transcript.provider === "codex" ? "Codex" : "Claude"}
                        </span>
                        <span aria-hidden>·</span>
                        <span
                          className="max-w-32 truncate text-foreground/70"
                          title={transcript.cwd}
                        >
                          {transcriptProject(transcript.cwd)}
                        </span>
                        <span aria-hidden>·</span>
                        <time dateTime={transcript.updatedAt}>
                          {transcriptTime(transcript.updatedAt)}
                        </time>
                      </span>
                    </span>
                    <span className="mt-1 translate-x-1 font-mono text-[10px] text-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100">
                      {t("dock.resume")}
                    </span>
                  </button>
                );
              })
            )}
          </section>
        </section>,
        document.body,
      )
    : null;

  return (
    <>
      <div className="relative" ref={rootRef}>
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t("dock.conversationsAria")}
          className={cn(
            "grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
            open && "bg-muted text-foreground",
          )}
          onClick={() => {
            setOpen((value) => !value);
          }}
          title={t("dock.conversations")}
          type="button"
        >
          <History className="size-3.5" />
        </button>
      </div>
      {popover}
    </>
  );
}
