import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Plus, Save, Search, Star, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { TabStrip } from "@/components/ui/tab-strip";
import {
  createContextNote,
  deleteContextNote,
  getContextGraph,
  getContextNote,
  listContext,
  previewContext,
  setContextPins,
  updateContextNote,
  type ContextGraph as ContextGraphData,
  type ContextItem,
  type ContextLibrarySnapshot,
  type ContextNote,
  type ContextPreview,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useAgentDock } from "@/features/agent/chat/agent-context";
import { migrateLegacyGists } from "./gist-migration";
import { ContextItemTree, } from "./context-item-tree";
import { ContextPreviewPanel, EntityDetail } from "./context-preview-panel";
import { key } from "./context-refs";

const CodeEditor = lazy(() => import("@/features/git/code-editor").then((module) => ({ default: module.CodeEditor })));
const ContextGraph = lazy(() => import("./context-graph").then((module) => ({ default: module.ContextGraph })));

type ViewMode = "list" | "graph";



export function ContextView({ projectPath }: { projectPath?: string | null }) {
  const t = useT();
  const { attachContextItem } = useAgentDock();
  const [snapshot, setSnapshot] = useState<ContextLibrarySnapshot | null>(null);
  const [graph, setGraph] = useState<ContextGraphData | null>(null);
  const [selected, setSelected] = useState<ContextItem | null>(null);
  const [note, setNote] = useState<ContextNote | null>(null);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [mode, setMode] = useState<ViewMode>("list");
  const [showSessions, setShowSessions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const migrationStarted = useRef(false);
  const selectedRef = useRef<ContextItem | null>(null);
  const dirtyRef = useRef(false);
  selectedRef.current = selected;
  dirtyRef.current = Boolean(note && (draft !== note.body || title !== note.title));

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const kinds = showSessions
      ? undefined
      : (["note", "project", "service", "file", "incident"] as const);
    try {
      const [next, nextGraph] = await Promise.all([
        listContext({ q: debouncedQuery || undefined, projectPath: projectPath ?? undefined, kinds: kinds ? [...kinds] : undefined }),
        mode === "graph"
          ? getContextGraph({ q: debouncedQuery || undefined, projectPath: projectPath ?? undefined, kinds: kinds ? [...kinds] : undefined })
          : Promise.resolve(null),
      ]);
      setSnapshot(next);
      if (nextGraph) setGraph(nextGraph);
      setSelected((current) => {
        if (!current) return next.items[0] ?? null;
        const refreshed = next.items.find((item) => key(item.ref) === key(current.ref));
        return refreshed ?? (dirtyRef.current ? current : null);
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, mode, projectPath, showSessions]);

  useEffect(() => {
    if (migrationStarted.current) {
      void refresh();
      return;
    }
    migrationStarted.current = true;
    void migrateLegacyGists().then(refresh).catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
      void refresh();
    });
  }, [refresh]);

  useEffect(() => {
    if (!selected || selected.kind !== "note") {
      setNote(null);
      setDraft("");
      setTitle(selected?.title ?? "");
      return;
    }
    let active = true;
    void getContextNote(selected.ref.id).then((loaded) => {
      if (!active) return;
      setNote(loaded);
      setDraft(loaded.body);
      setTitle(loaded.title);
    }).catch((caught) => active && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => { active = false; };
  }, [selected?.kind, selected?.ref.id]);

  useEffect(() => {
    // Notes already expose their full body in list mode. Resolve them only for
    // the graph inspector, avoiding a second vault scan beside getContextNote.
    if (!selected || (selected.kind === "note" && mode === "list")) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let active = true;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    void previewContext(
      { refs: [selected.ref], includePinned: false },
      projectPath ?? undefined,
    ).then((loaded) => {
      if (active) setPreview(loaded);
    }).catch((caught) => {
      if (active) setPreviewError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (active) setPreviewLoading(false);
    });
    return () => { active = false; };
  }, [mode, note?.revision, projectPath, selected?.kind, selected?.ref.id]);

  const pinnedKeys = useMemo(() => new Set((snapshot?.pinned ?? []).map(key)), [snapshot?.pinned]);
  /**
   * What to do once the discard question is answered. Held as an object so
   * `setState` takes it as a value rather than as an updater function.
   */
  const [pendingDiscard, setPendingDiscard] = useState<{ run: () => void } | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);

  /** Runs `action`, asking first when the open note has unsaved edits. */
  function withDiscardGuard(action: () => void) {
    if (!dirtyRef.current) {
      action();
      return;
    }
    setPendingDiscard({ run: action });
  }

  async function createNote() {
    setPendingDiscard(null);
    setSaving(true);
    try {
      const created = await createContextNote({ title: t("context.untitled"), projectPaths: projectPath ? [projectPath] : [] });
      await refresh();
      setSelected(created);
      setNote(created);
      setTitle(created.title);
      setDraft(created.body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  }

  async function saveNote() {
    if (!note) return;
    setSaving(true);
    try {
      const updated = await updateContextNote(note.ref.id, {
        title,
        body: draft,
        projectPaths: note.projectPaths,
        tags: note.tags,
        aliases: note.aliases,
        revision: note.revision,
      });
      setNote(updated);
      setSelected(updated);
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  }

  async function removeNote() {
    if (!note) return;
    setPendingDelete(false);
    setSaving(true);
    try { await deleteContextNote(note.ref.id, note.revision); setSelected(null); setNote(null); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  }

  async function togglePin(item: ContextItem) {
    if (!snapshot) return;
    const itemKey = key(item.ref);
    const refs = pinnedKeys.has(itemKey)
      ? snapshot.pinned.filter((ref) => key(ref) !== itemKey)
      : [...snapshot.pinned, item.ref];
    try { await setContextPins(refs); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  function selectItem(item: ContextItem) {
    const switchingAway =
      selectedRef.current && key(selectedRef.current.ref) !== key(item.ref);
    if (switchingAway) {
      withDiscardGuard(() => setSelected(item));
      return;
    }
    setSelected(item);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/75 px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">{t("context.title")}</h2>
          <p className="max-w-96 truncate font-mono text-[9px] text-muted-foreground" title={snapshot?.vaultPath}>{snapshot?.vaultPath ?? t("context.vaultFallback")}</p>
        </div>
        <div className="ml-auto">
          <TabStrip<ViewMode>
            ariaLabel={t("context.view")}
            idPrefix="context-view"
            onSelect={setMode}
            tabs={[
              { id: "list", label: t("context.list") },
              { id: "graph", label: t("context.graph") },
            ]}
            value={mode}
          />
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input className="size-3.5" checked={showSessions} onChange={(event) => setShowSessions(event.target.checked)} type="checkbox" />
          {t("context.sessions")}
        </label>
        <Button className="h-7 px-2 text-[11px] [&_svg]:size-3.5" disabled={saving} onClick={() => withDiscardGuard(() => void createNote())} size="sm"><Plus aria-hidden="true" />{t("context.newNote")}</Button>
      </header>

      {error ? <Alert className="m-3 shrink-0" variant="destructive">{error}</Alert> : null}

      <div aria-labelledby={`context-view-tab-${mode}`} className="grid min-h-0 flex-1 md:grid-cols-[280px_minmax(0,1fr)]" id={`context-view-panel-${mode}`} role="tabpanel">
        <aside className="flex min-h-0 flex-col border-r border-border">
          <div className="border-b border-border p-2">
            <div className="flex h-7 items-center gap-2 border border-border bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
              <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <Input aria-label={t("context.search")} className="h-auto border-0 bg-transparent p-0 text-[11px] shadow-none focus-visible:ring-0" onChange={(event) => setQuery(event.target.value)} placeholder={t("context.searchPlaceholder")} value={query} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading && !snapshot ? <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />{t("context.loading")}</div> : null}
            {snapshot ? <ContextItemTree items={snapshot.items} onSelect={selectItem} query={debouncedQuery} selected={selected} /> : null}
          </div>
        </aside>

        <section className="min-h-0 overflow-hidden">
          {mode === "graph" && graph && snapshot ? (
            <div className="grid h-full min-h-0 grid-rows-[minmax(260px,1fr)_minmax(0,0.8fr)] lg:grid-cols-[minmax(0,1fr)_minmax(260px,34%)] lg:grid-rows-1">
              <Suspense fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground"><LoaderCircle className="mr-2 inline size-3 animate-spin" />{t("context.graphLoading")}</div>}>
                <ContextGraph graph={graph} items={snapshot.items} onSelect={selectItem} selected={selected?.ref} />
              </Suspense>
              {selected ? (
                <ContextPreviewPanel
                  className="border-t border-border lg:border-l lg:border-t-0"
                  error={previewError}
                  item={selected}
                  loading={previewLoading}
                  preview={preview}
                />
              ) : null}
            </div>
          ) : selected ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                {note ? <Input aria-label={t("context.noteTitle")} className="h-7 max-w-xl text-[13px] font-semibold" onChange={(event) => setTitle(event.target.value)} value={title} /> : <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{selected.title}</h3>}
                <Badge size="small" variant="outline">{selected.kind}</Badge>
                <Button className="h-7 px-2 text-[11px]" onClick={() => attachContextItem(selected)} size="sm" variant="outline">{t("context.attach")}</Button>
                <Button aria-label={selected.pinned ? t("context.unpin") : t("context.pin")} onClick={() => void togglePin(selected)} size="icon-sm" variant="ghost"><Star aria-hidden="true" className={cn(selected.pinned && "fill-current text-amber-500")} /></Button>
                {note ? <><Button aria-label={t("context.save")} disabled={saving || (!title.trim())} onClick={() => void saveNote()} size="icon-sm"><Save aria-hidden="true" /></Button><Button aria-label={t("context.delete")} disabled={saving} onClick={() => setPendingDelete(true)} size="icon-sm" variant="destructive"><Trash2 aria-hidden="true" /></Button></> : null}
              </div>
              {note ? <div className="min-h-0 flex-1 overflow-auto"><Suspense fallback={<div className="p-3 text-xs text-muted-foreground">{t("context.editorLoading")}</div>}><CodeEditor ariaLabel={t("context.editor")} onChange={setDraft} path={`${note.title}.md`} value={draft} /></Suspense></div> : <EntityDetail error={previewError} item={selected} loading={previewLoading} preview={preview} />}
            </div>
          ) : <div className="grid h-full place-items-center text-xs text-muted-foreground">{t("context.empty")}</div>}
        </section>
      </div>
      {pendingDiscard ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("context.discard")}
          icon={<Trash2 className="text-destructive" />}
          message={t("context.discardConfirmBody")}
          onCancel={() => setPendingDiscard(null)}
          onConfirm={pendingDiscard.run}
          title={t("context.discardConfirm")}
          tone="danger"
        />
      ) : null}
      {pendingDelete && note ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          icon={<Trash2 className="text-destructive" />}
          loading={saving}
          message={t("context.deleteConfirm")}
          onCancel={() => setPendingDelete(false)}
          onConfirm={() => void removeNote()}
          title={t("context.deleteTitle", { title: note.title })}
          tone="danger"
        />
      ) : null}
    </div>
  );
}
