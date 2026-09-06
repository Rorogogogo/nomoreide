import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Search } from "lucide-react";
import {
  searchSkills,
  type OneTimeSkillSelection,
  type RemoteSkillResult,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

/** Registry skill search, as it appears inside the skills dropdown. */

export function formatInstalls(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}

export function SkillSearch({
  children,
  onClose,
  onSelect,
}: {
  children: ReactNode;
  onClose: () => void;
  onSelect: (skill: OneTimeSkillSelection) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RemoteSkillResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);
  const searching = query.trim().length > 0;

  useEffect(() => {
    const trimmed = query.trim();
    const sequence = ++sequenceRef.current;
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      void searchSkills(trimmed)
        .then((skills) => {
          if (sequenceRef.current === sequence) setResults(skills);
        })
        .catch((reason) => {
          if (sequenceRef.current !== sequence) return;
          setResults([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (sequenceRef.current === sequence) setLoading(false);
        });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border p-1.5">
        <label className="flex h-7 items-center gap-1.5 rounded-sm border border-border bg-background px-2 text-muted-foreground focus-within:border-foreground/40">
          <Search className="size-3" aria-hidden />
          <input
            aria-label={t("dock.skillSearchAria")}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("dock.skillSearchPlaceholder")}
            value={query}
          />
        </label>
      </div>
      <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto p-1">
        {!searching ? children : null}
        {searching && loading ? (
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            {t("dock.skillSearchLoading")}
          </p>
        ) : null}
        {searching && !loading && error ? (
          <p className="px-2 py-1 text-[10px] text-red-500" title={error}>
            {t("dock.skillSearchError")}
          </p>
        ) : null}
        {searching && !loading && !error && query.trim().length >= 2 && results.length === 0 ? (
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            {t("dock.skillSearchEmpty")}
          </p>
        ) : null}
        {searching && !loading && !error
          ? results.map((skill) => (
              <div
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted"
                key={skill.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] text-foreground">{skill.name}</p>
                  <p className="truncate text-[9px] text-muted-foreground">
                    {skill.source} · {formatInstalls(skill.installs)}
                  </p>
                </div>
                <a
                  aria-label={t("dock.skillOpenSource", { name: skill.name })}
                  className="text-muted-foreground hover:text-foreground"
                  href={skill.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="size-3" aria-hidden />
                </a>
                <button
                  className="shrink-0 rounded-sm border border-border px-1.5 py-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() => {
                    onSelect({ name: skill.name, source: skill.useSource });
                    onClose();
                  }}
                  type="button"
                >
                  {t("dock.skillUseOnce")}
                </button>
              </div>
            ))
          : null}
      </div>
    </div>
  );
}

/** Close on outside click, Escape, or an ancestor scrolling out from under. */