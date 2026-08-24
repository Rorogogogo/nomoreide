/**
 * The Git page's search panel: find a file by name, or find a string inside the
 * files — an editor's Cmd+P and Cmd+Shift+F, over the selected repository.
 *
 * Both searches answer from `nomoreide-core`'s Git manager, which walks what
 * `git ls-files` reports. That is why there is no "exclude node_modules"
 * control here and never needs to be: an untracked path is not searched, so
 * the noise an editor spends settings on is absent by construction.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CaseSensitive, Regex, Search, WholeWord } from "lucide-react";
import { searchGitContent, searchGitFiles } from "@/lib/api";
import type { ContentSearchResult, FileNameMatch } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ContentResults, FileNameResults } from "./search-results";

type SearchMode = "files" | "content";

/** Long enough that a typed word is one request, short enough to feel live. */
const DEBOUNCE_MS = 220;

const EMPTY_CONTENT: ContentSearchResult = {
  files: [],
  totalMatches: 0,
  truncated: false,
};

export function SearchView({
  onOpenFile,
}: {
  /** Open a result in the All-files viewer, at `line` when the hit names one. */
  onOpenFile: (path: string, line?: number) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<SearchMode>("files");
  const [query, setQuery] = useState("");
  const [include, setInclude] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);

  const [files, setFiles] = useState<FileNameMatch[]>([]);
  const [content, setContent] = useState<ContentSearchResult>(EMPTY_CONTENT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which request the results on screen belong to. A slow search for `wid`
   * must not overwrite a fast one for `widget` typed after it, and a plain
   * `await` cannot tell the two apart once both are in flight.
   */
  const requestRef = useRef(0);

  const run = useCallback(async () => {
    const token = ++requestRef.current;
    const trimmed = query.trim();

    if (!trimmed && mode === "content") {
      setContent(EMPTY_CONTENT);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      if (mode === "files") {
        const found = await searchGitFiles(trimmed, 200);
        if (token !== requestRef.current) return;
        setFiles(found);
      } else {
        const found = await searchGitContent(trimmed, {
          caseSensitive,
          include,
          regex,
          wholeWord,
        });
        if (token !== requestRef.current) return;
        setContent(found);
      }
      setError(null);
    } catch (reason) {
      if (token !== requestRef.current) return;
      // A malformed regex arrives here with the engine's own wording, which is
      // more useful under the input than anything this component could invent.
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (token === requestRef.current) setLoading(false);
    }
  }, [caseSensitive, include, mode, query, regex, wholeWord]);

  useEffect(() => {
    const timer = setTimeout(run, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [run]);

  const trimmed = query.trim();
  const showFileHint = mode === "content" && !trimmed;
  const empty =
    !loading &&
    !error &&
    !showFileHint &&
    (mode === "files" ? files.length === 0 : content.files.length === 0);

  return (
    <section
      aria-label={t("git.search.aria")}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-card/85"
    >
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <div className="flex gap-0.5">
          <ModeButton active={mode === "files"} onClick={() => setMode("files")}>
            {t("git.search.modeFiles")}
          </ModeButton>
          <ModeButton active={mode === "content"} onClick={() => setMode("content")}>
            {t("git.search.modeContent")}
          </ModeButton>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            className="h-8 pl-8 text-xs"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(
              mode === "files"
                ? "git.search.filesPlaceholder"
                : "git.search.contentPlaceholder",
            )}
            value={query}
          />
        </div>

        {mode === "content" ? (
          <div className="flex items-center gap-2">
            <Input
              className="h-8 flex-1 font-mono text-[11px]"
              onChange={(event) => setInclude(event.target.value)}
              placeholder={t("git.search.includePlaceholder")}
              value={include}
            />
            <div className="flex shrink-0 gap-0.5">
              <Toggle
                active={caseSensitive}
                label={t("git.search.caseAria")}
                onClick={() => setCaseSensitive((on) => !on)}
              >
                <CaseSensitive className="size-3.5" />
              </Toggle>
              <Toggle
                active={wholeWord}
                label={t("git.search.wordAria")}
                onClick={() => setWholeWord((on) => !on)}
              >
                <WholeWord className="size-3.5" />
              </Toggle>
              <Toggle
                active={regex}
                label={t("git.search.regexAria")}
                onClick={() => setRegex((on) => !on)}
              >
                <Regex className="size-3.5" />
              </Toggle>
            </div>
          </div>
        ) : null}

        <p aria-live="polite" className="text-[11px] text-muted-foreground">
          {loading
            ? t("git.search.searching")
            : mode === "files"
              ? t("git.search.fileCount", { count: files.length })
              : t("git.search.matchCount", {
                  files: content.files.length,
                  matches: content.totalMatches,
                })}
        </p>
      </div>

      {error ? (
        <Alert className="m-3" variant="destructive">
          {error}
        </Alert>
      ) : null}

      {content.truncated && mode === "content" && !error ? (
        <p className="border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
          {t("git.search.truncated")}
        </p>
      ) : null}

      {showFileHint ? (
        <Hint>{t("git.search.startTyping")}</Hint>
      ) : empty ? (
        <Hint>{t("git.search.noResults")}</Hint>
      ) : mode === "files" ? (
        <FileNameResults matches={files} onOpenFile={onOpenFile} />
      ) : (
        <ContentResults onOpenFile={onOpenFile} result={content} />
      )}

      <p className="shrink-0 border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
        {t("git.search.trackedOnly")}
      </p>
    </section>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center p-6">
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

function ModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "rounded-md px-2.5 py-1 text-xs transition-colors",
        active
          ? "bg-accent/15 font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Toggle({
  active,
  children,
  label,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "rounded-md border p-1.5 transition-colors",
        active
          ? "border-accent/40 bg-accent/15 text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
