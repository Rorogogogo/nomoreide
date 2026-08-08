import { useMemo, useRef, useState } from "react";
import { History, LoaderCircle, Search, X } from "lucide-react";
import type { AgentTranscriptInfo } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ClaudeLogo, CodexLogo } from "../agent-logos";

/** Recency buckets, in the order a chat sidebar shows them. */
const HISTORY_BUCKETS = [
  "today",
  "yesterday",
  "previous7",
  "previous30",
  "older",
] as const;

type HistoryBucket = (typeof HISTORY_BUCKETS)[number];

export function transcriptTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function transcriptProject(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || cwd;
}

/**
 * Which recency bucket a timestamp belongs to, measured in whole calendar days
 * rather than elapsed hours — "yesterday" has to mean yesterday's date, not
 * 24 hours ago, or a 9am session reads as "today" until 9am the next morning.
 */
export function transcriptBucket(value: string, now: Date): HistoryBucket {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "older";
  const startOfDay = (input: Date) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const days = Math.floor(
    (startOfDay(now) - startOfDay(date)) / 86_400_000,
  );
  // Clock skew or a future mtime lands in "today" rather than falling through
  // to "older", which would bury the newest session at the bottom.
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "previous7";
  if (days <= 30) return "previous30";
  return "older";
}

/**
 * Search field and result rows for prior agent conversations.
 *
 * Rows are deliberately single-line titles grouped by recency — the shape every
 * chat app uses — because the sidebar's job is to let you find a thread by
 * skimming, and per-row metadata (provider, project, timestamp) costs a second
 * line for information you only want on the one row you are considering. It
 * lives in the row's tooltip instead.
 */
export function AgentConversationList({
  error,
  loading,
  onResume,
  transcripts,
}: {
  error: string | null;
  loading: boolean;
  onResume: (transcript: AgentTranscriptInfo) => void;
  transcripts: AgentTranscriptInfo[];
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // One list, both agents: the recency order is what makes a thread findable,
  // and splitting it by provider hid the session you actually reached for. The
  // per-row mark still says which agent ran it, and search matches on the
  // provider name for the times you do want only one of them.
  const filteredTranscripts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return transcripts;
    return transcripts.filter((transcript) => {
      const providerName = transcript.provider === "codex" ? "codex" : "claude code";
      return `${transcript.title} ${providerName} ${transcriptProject(transcript.cwd)}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [query, transcripts]);

  const groups = useMemo(() => {
    const now = new Date();
    const buckets = new Map<HistoryBucket, AgentTranscriptInfo[]>();
    for (const transcript of filteredTranscripts) {
      const bucket = transcriptBucket(transcript.updatedAt, now);
      const existing = buckets.get(bucket);
      if (existing) existing.push(transcript);
      else buckets.set(bucket, [transcript]);
    }
    return HISTORY_BUCKETS.flatMap((bucket) => {
      const items = buckets.get(bucket);
      return items?.length ? [{ bucket, items }] : [];
    });
  }, [filteredTranscripts]);

  return (
    <>
      <div className="shrink-0 px-2 pb-1.5 pt-2">
        <div className="flex h-7 items-center gap-2 rounded-md px-1.5 text-muted-foreground focus-within:bg-muted/60 focus-within:text-foreground hover:bg-muted/40">
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
      </div>
      <section
        aria-label={t("dock.conversationResults")}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2 [scrollbar-gutter:stable]"
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
        ) : groups.length === 0 ? (
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
          groups.map(({ bucket, items }) => (
            <div className="mb-1 last:mb-0" key={bucket}>
              <h3 className="px-2 pb-0.5 pt-2 text-[10px] font-medium text-muted-foreground">
                {t(`dock.history.${bucket}`)}
              </h3>
              {items.map((transcript, index) => {
                const ProviderLogo =
                  transcript.provider === "codex" ? CodexLogo : ClaudeLogo;
                return (
                  <button
                    className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/70 focus-visible:bg-muted focus-visible:outline-none"
                    // Codex reuses one session id across a conversation's
                    // rollout files, so the id alone is not unique and React
                    // would silently drop the duplicates. Rows hold no state of
                    // their own and the whole list is re-derived per render, so
                    // the position is a safe tiebreaker here.
                    // biome-ignore lint/suspicious/noArrayIndexKey: session ids repeat; see above
                    key={`${transcript.provider}:${transcript.id}:${index}`}
                    onClick={() => onResume(transcript)}
                    title={`${transcript.title}\n${
                      transcript.provider === "codex" ? "Codex" : "Claude"
                    } · ${transcriptProject(transcript.cwd)} · ${transcriptTime(
                      transcript.updatedAt,
                    )}`}
                    type="button"
                  >
                    {/* No text colour here — the mark carries its brand one, so
                        the provider is readable at a glance down the list. */}
                    <ProviderLogo className="size-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-xs leading-5">
                      {transcript.title}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </section>
    </>
  );
}
