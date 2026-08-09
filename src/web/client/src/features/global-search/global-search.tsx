import {
  Bot,
  Boxes,
  FileCode2,
  FolderGit2,
  GitBranch,
  Search,
  Server,
  Settings,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { AppPage } from "@/components/app-navigation";
import { useAgentDock } from "@/features/agent/chat/agent-context";
import type { DashboardData } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  buildGlobalSearchItems,
  GLOBAL_SEARCH_KIND_META,
  GLOBAL_SEARCH_KINDS,
  searchGlobalItems,
  type GlobalSearchItem,
  type GlobalSearchKind,
} from "./global-search-model";
import { requestGlobalSearchFocus } from "./global-search-navigation";

export interface GlobalSearchProps {
  data: DashboardData | null;
  onNavigate: (page: AppPage) => void;
  onOpenGit: () => void;
  onOpenService: (name: string) => void;
  onSelectProject: (name: string) => Promise<void>;
}

const GROUP_ICONS: Record<GlobalSearchKind, ReactNode> = {
  page: <Search />,
  setting: <Settings />,
  project: <FolderGit2 />,
  service: <Server />,
  bundle: <Boxes />,
  branch: <GitBranch />,
  file: <FileCode2 />,
  "agent-task": <Bot />,
};

export function GlobalSearch({
  data,
  onNavigate,
  onOpenGit,
  onOpenService,
  onSelectProject,
}: GlobalSearchProps) {
  const t = useT();
  const { tasks, setActiveTaskId, setOpen: setAgentOpen } = useAgentDock();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const activationRef = useRef(0);

  const items = useMemo(
    () => buildGlobalSearchItems({ data, tasks, translate: t }),
    [data, tasks, t],
  );
  const results = useMemo(() => searchGlobalItems(items, query), [items, query]);

  const openPalette = useCallback(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setError(null);
    setOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    activationRef.current += 1;
    setOpen(false);
    setError(null);
    window.requestAnimationFrame(() => {
      (previousFocusRef.current ?? triggerRef.current)?.focus();
    });
  }, []);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (open && event.key === "Escape") {
        event.preventDefault();
        closePalette();
        return;
      }
      if (event.repeat || event.key.toLocaleLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (open) closePalette();
      else openPalette();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [closePalette, open, openPalette]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!results.length) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((current) => Math.min(current, results.length - 1));
  }, [results.length]);

  useEffect(() => {
    if (!open || !results.length) return;
    document.getElementById(`global-search-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, results.length]);

  async function activate(item: GlobalSearchItem) {
    if (busy) return;
    const activation = ++activationRef.current;
    setError(null);
    try {
      switch (item.target.type) {
        case "page":
          onNavigate(item.target.page);
          break;
        case "setting":
          requestGlobalSearchFocus(item.target);
          onNavigate("settings");
          break;
        case "project":
          setBusy(true);
          await onSelectProject(item.target.name);
          if (activation !== activationRef.current) {
            setBusy(false);
            return;
          }
          break;
        case "service":
          onOpenService(item.target.name);
          break;
        case "bundle":
          if (item.target.firstService) onOpenService(item.target.firstService);
          else onNavigate("services");
          break;
        case "branch":
          onOpenGit();
          break;
        case "file":
          requestGlobalSearchFocus({ type: "git-file", path: item.target.path });
          onOpenGit();
          break;
        case "agent-task":
          setActiveTaskId(item.target.id);
          setAgentOpen(true);
          break;
      }
      setBusy(false);
      closePalette();
    } catch (caught) {
      setBusy(false);
      if (activation === activationRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => results.length ? (current + 1) % results.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => results.length ? (current - 1 + results.length) % results.length : 0);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, results.length - 1));
    } else if (event.key === "Enter" && results[activeIndex]) {
      event.preventDefault();
      void activate(results[activeIndex]);
    } else if (event.key === "Tab") {
      event.preventDefault();
      closeRef.current?.focus();
    }
  }

  const grouped = GLOBAL_SEARCH_KINDS.map((kind) => ({
    kind,
    items: results.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        aria-label={t("globalSearch.open")}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={openPalette}
        ref={triggerRef}
        type="button"
      >
        <Search aria-hidden className="size-3.5" />
        <span className="hidden lg:inline">{t("common.search")}</span>
        <kbd className="hidden rounded border border-border bg-muted/40 px-1 font-mono text-[9px] xl:inline">
          {shortcutLabel()}
        </kbd>
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-[1000] flex items-start justify-center px-2 pt-[min(14vh,7rem)]">
              <button
                aria-label={t("globalSearch.close")}
                className="absolute inset-0 cursor-default bg-black/35"
                onClick={closePalette}
                tabIndex={-1}
                type="button"
              />
              <div
                aria-label={t("globalSearch.title")}
                aria-modal="true"
                className="relative flex max-h-[min(70vh,34rem)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
                role="dialog"
              >
                <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
                  <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    aria-activedescendant={results.length ? `global-search-option-${activeIndex}` : undefined}
                    aria-autocomplete="list"
                    aria-controls="global-search-results"
                    aria-expanded="true"
                    aria-label={t("globalSearch.inputAria")}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={handleInputKeyDown}
                    placeholder={t("globalSearch.placeholder")}
                    ref={inputRef}
                    role="combobox"
                    value={query}
                  />
                  <button
                    aria-label={t("globalSearch.close")}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={closePalette}
                    onKeyDown={(event) => {
                      if (event.key === "Tab") {
                        event.preventDefault();
                        inputRef.current?.focus();
                      }
                    }}
                    ref={closeRef}
                    type="button"
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                </div>

                <div
                  aria-label={t("globalSearch.results")}
                  className="min-h-0 flex-1 overflow-y-auto p-1.5"
                  id="global-search-results"
                  role="listbox"
                >
                  {grouped.map((group) => (
                    <section aria-label={t(GLOBAL_SEARCH_KIND_META[group.kind].labelKey)} key={group.kind}>
                      <div className="px-2 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {t(GLOBAL_SEARCH_KIND_META[group.kind].labelKey)}
                      </div>
                      {group.items.map((item) => {
                        const index = results.indexOf(item);
                        const active = index === activeIndex;
                        return (
                          <button
                            aria-selected={active}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none",
                              active && "bg-muted/45",
                            )}
                            disabled={busy}
                            id={`global-search-option-${index}`}
                            key={item.id}
                            onClick={() => void activate(item)}
                            onMouseEnter={() => setActiveIndex(index)}
                            role="option"
                            tabIndex={-1}
                            type="button"
                          >
                            <span className="grid size-6 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">
                              {GROUP_ICONS[item.kind]}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-foreground">{item.label}</span>
                              {item.detail ? (
                                <span className="block truncate font-mono text-[9px] text-muted-foreground" title={item.detail}>
                                  {item.detail}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </section>
                  ))}
                  {!results.length ? (
                    <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                      {t("globalSearch.empty", { query: query.trim() })}
                    </div>
                  ) : null}
                </div>

                <div aria-live="polite" className="flex min-h-8 shrink-0 items-center justify-between border-t border-border px-3 text-[9px] text-muted-foreground">
                  <span>{error ?? (busy ? t("globalSearch.opening") : t("globalSearch.hint"))}</span>
                  <span>{t("globalSearch.resultCount", { count: results.length })}</span>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function shortcutLabel(platform = globalThis.navigator?.platform ?? ""): string {
  return /Mac|iPhone|iPad/i.test(platform) ? "⌘K" : "Ctrl K";
}
