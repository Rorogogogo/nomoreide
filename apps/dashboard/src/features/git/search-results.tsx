/**
 * The two result lists behind {@link SearchView}, kept apart from it so the
 * panel file stays about state and this one stays about rendering.
 *
 * Both lists highlight the matched span rather than restating it, because the
 * question a result answers is "is this the one" — and that is read from where
 * the match falls, not from the path repeated underneath it.
 */
import { Fragment } from "react";
import type { ContentSearchResult, FileNameMatch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { FileKindIcon } from "./file-kind-icon";

/**
 * Wrap the characters at `positions` in a highlight.
 *
 * Offsets are characters, not bytes — the server counts them the same way, so
 * a path with an accent in it highlights the span the user actually typed.
 */
function Highlighted({ text, positions }: { text: string; positions: readonly number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const marked = new Set(positions);
  const characters = [...text];

  // Adjacent characters of the same kind collapse into one run, so `widget`
  // matched whole renders as a single <mark> rather than six.
  const runs: Array<{ start: number; text: string; matched: boolean }> = [];
  for (const [index, character] of characters.entries()) {
    const matched = marked.has(index);
    const last = runs.at(-1);
    if (last && last.matched === matched) last.text += character;
    else runs.push({ start: index, text: character, matched });
  }

  return (
    <>
      {runs.map((run) =>
        run.matched ? (
          <mark
            className="rounded-[2px] bg-amber-200/80 text-inherit dark:bg-amber-500/40"
            key={run.start}
          >
            {run.text}
          </mark>
        ) : (
          <Fragment key={run.start}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}

/** A path split into the directory that leads to it and the name itself. */
function pathParts(path: string): { directory: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { directory: "", name: path }
    : { directory: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

export function FileNameResults({
  matches,
  onOpenFile,
  selectedPath,
}: {
  matches: readonly FileNameMatch[];
  onOpenFile: (path: string) => void;
  selectedPath?: string;
}) {
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto py-1">
      {matches.map((match) => {
        const { directory, name } = pathParts(match.path);
        // The highlight offsets index the whole path, so the name's share of
        // them has to be shifted back by the directory it no longer follows.
        const namePositions = match.positions
          .filter((position) => position >= directory.length)
          .map((position) => position - directory.length);
        return (
          <li key={match.path}>
            <button
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/10",
                selectedPath === match.path && "bg-accent/15",
              )}
              onClick={() => onOpenFile(match.path)}
              type="button"
            >
              <FileKindIcon path={match.path} />
              <span className="truncate font-medium text-foreground">
                <Highlighted positions={namePositions} text={name} />
              </span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
                {directory}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ContentResults({
  onOpenFile,
  result,
}: {
  onOpenFile: (path: string, line: number) => void;
  result: ContentSearchResult;
}) {
  const t = useT();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      {result.files.map((file) => (
        <section key={file.path}>
          <header className="sticky top-0 z-10 flex items-center gap-2 bg-card/95 px-3 py-1 backdrop-blur">
            <FileKindIcon path={file.path} />
            <span className="truncate text-xs font-medium text-foreground">
              {pathParts(file.path).name}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {pathParts(file.path).directory}
            </span>
            <span className="shrink-0 rounded bg-muted px-1.5 text-[11px] text-muted-foreground">
              {file.matches.length}
              {file.truncated ? "+" : ""}
            </span>
          </header>
          <ul>
            {file.matches.map((match) => (
              <li key={`${match.line}-${match.start}`}>
                <button
                  className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-accent/10"
                  onClick={() => onOpenFile(file.path, match.line)}
                  type="button"
                >
                  <span className="w-10 shrink-0 select-none text-right font-mono text-[11px] text-muted-foreground">
                    {match.line}
                  </span>
                  {/*
                    The line keeps its leading whitespace trimmed only at the
                    start: an indented hit should not push its own text out of
                    view, but the text after the match still reads as code.
                  */}
                  <span className="truncate font-mono text-[11px] text-foreground">
                    <MatchedLine
                      end={match.end}
                      start={match.start}
                      text={match.text}
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {file.truncated ? (
            <p className="px-3 pb-1 pl-[3.25rem] text-[11px] text-muted-foreground">
              {t("git.search.fileTruncated")}
            </p>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/** One matching line with its span marked, indentation collapsed to a stub. */
function MatchedLine({ text, start, end }: { text: string; start: number; end: number }) {
  const characters = [...text];
  const indent = characters.findIndex((character) => character !== " " && character !== "\t");
  // A hit inside the indentation would be lost by trimming it, so the trim only
  // applies to what precedes the match.
  const trim = indent > 0 && indent <= start ? indent : 0;
  return (
    <>
      {characters.slice(trim, start).join("")}
      <mark className="rounded-[2px] bg-amber-200/80 text-inherit dark:bg-amber-500/40">
        {characters.slice(start, end).join("")}
      </mark>
      {characters.slice(end).join("")}
    </>
  );
}
