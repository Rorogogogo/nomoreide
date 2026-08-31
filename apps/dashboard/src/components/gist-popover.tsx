import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileImage, FileText, ImagePlus, Send, Trash2, X } from "lucide-react";
import { useAgentDock } from "@/features/agent/chat/agent-context";
import { AiContextTarget } from "@/features/agent/context-menu/ai-context-menu";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useT } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { headerActionClassName, headerActionIconClassName } from "./header-action";
import { Badge } from "./ui/badge";
import { Tooltip } from "./ui/tooltip";

interface GistPiece {
  id: string;
  type: "text" | "image";
  value: string;
  name?: string;
}

interface GistDraft {
  pieces: GistPiece[];
}

interface GistProject {
  name: string;
  path: string;
}

interface ProjectGist extends GistProject {
  gist: GistDraft | null;
}

interface ScopedGistPiece {
  piece: GistPiece;
  projectLabel?: string;
  projectPath?: string;
  scopeKey: string;
}

const EMPTY_GIST: GistDraft = { pieces: [] };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function normalizeGist(value: GistDraft | { title?: string; body?: string } | null): GistDraft | null {
  if (!value) return null;
  if ("pieces" in value) return value;
  return {
    pieces: value.body?.trim()
      ? [{ id: crypto.randomUUID(), type: "text", value: value.body }]
      : [],
  };
}

function gistStorageKey(scopeKey: string) {
  return `nomoreide:gist:current:${scopeKey}`;
}

function readStoredGist(scopeKey: string): GistDraft | null {
  try {
    const raw = window.localStorage.getItem(gistStorageKey(scopeKey));
    return raw ? normalizeGist(JSON.parse(raw) as GistDraft) : null;
  } catch {
    return null;
  }
}

function readProjectGists(projects: GistProject[]): ProjectGist[] {
  return projects.map((project) => ({
    ...project,
    gist: readStoredGist(project.path),
  }));
}

/** A small, persistent scratchpad for project notes, text snippets, and images. */
export function GistPopover({
  aggregateProjects = false,
  projects = [],
  scopeKey = "all",
}: {
  aggregateProjects?: boolean;
  projects?: GistProject[];
  scopeKey?: string;
}) {
  const t = useT();
  const { sendToAgent } = useAgentDock();
  const [storedGist, setStoredGist] = usePersistentState<GistDraft | null>(`gist:current:${scopeKey}`, null);
  const gist = normalizeGist(storedGist);
  const [open, setOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [sent, setSent] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const projectSignature = JSON.stringify(
    projects.map((project) => [project.name, project.path]),
  );
  const [projectGists, setProjectGists] = useState<ProjectGist[]>(() =>
    aggregateProjects ? readProjectGists(projects) : [],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (gist && storedGist && !("pieces" in storedGist)) setStoredGist(gist);
  }, [gist, setStoredGist, storedGist]);

  useEffect(() => {
    setProjectGists(aggregateProjects ? readProjectGists(projects) : []);
  }, [aggregateProjects, projectSignature]);

  const scopedPieces = useMemo<ScopedGistPiece[]>(() => {
    const currentPieces = (gist?.pieces ?? []).map((piece) => ({
      piece,
      projectLabel: aggregateProjects ? t("app.allProjects") : undefined,
      scopeKey,
    }));
    if (!aggregateProjects) return currentPieces;
    return [
      ...currentPieces,
      ...projectGists.flatMap((project) =>
        (project.gist?.pieces ?? []).map((piece) => ({
          piece,
          projectLabel: project.name,
          projectPath: project.path,
          scopeKey: project.path,
        })),
      ),
    ];
  }, [aggregateProjects, gist, projectGists, scopeKey, t]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest("[data-app-context-menu]")) return;
      if (target.closest("[data-gist-panel]")) return;
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const updateGist = (patch: Partial<GistDraft>) => {
    setStoredGist({ ...(gist ?? EMPTY_GIST), ...patch });
    setSent(false);
  };

  const createGist = () => {
    setStoredGist((current) => normalizeGist(current) ?? EMPTY_GIST);
    if (aggregateProjects) setProjectGists(readProjectGists(projects));
    setOpen(true);
    setSent(false);
  };

  const addTextPiece = () => {
    const value = textDraft.trim();
    if (!value) return;
    updateGist({
      pieces: [...(gist?.pieces ?? []), { id: crypto.randomUUID(), type: "text", value }],
    });
    setTextDraft("");
  };

  const addImagePiece = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(t("gist.imageTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      updateGist({
        pieces: [...(gist?.pieces ?? []), { id: crypto.randomUUID(), type: "image", value: reader.result, name: file.name }],
      });
      setImageError(null);
    };
    reader.readAsDataURL(file);
  };

  const addImageFiles = (files: FileList | File[]) => {
    const image = Array.from(files).find((file) => file.type.startsWith("image/"));
    addImagePiece(image);
  };

  const removePiece = (id: string, pieceScopeKey = scopeKey) => {
    if (pieceScopeKey === scopeKey) {
      updateGist({ pieces: (gist?.pieces ?? []).filter((piece) => piece.id !== id) });
      return;
    }
    const projectGist = readStoredGist(pieceScopeKey);
    const nextGist = {
      ...(projectGist ?? EMPTY_GIST),
      pieces: (projectGist?.pieces ?? []).filter((piece) => piece.id !== id),
    };
    try {
      window.localStorage.setItem(gistStorageKey(pieceScopeKey), JSON.stringify(nextGist));
    } catch {
      return;
    }
    setProjectGists((current) =>
      current.map((project) =>
        project.path === pieceScopeKey ? { ...project, gist: nextGist } : project,
      ),
    );
    setSent(false);
  };

  const sendPiece = (piece: GistPiece) => {
    if (piece.type !== "text") return;
    sendToAgent({
      label: "Gist note",
      mode: "send",
      prompt: piece.value,
      source: { type: "gist", label: "Gist note" },
    });
  };

  const sendGist = (extraText = "") => {
    const text = [...scopedPieces.map(({ piece }) => piece.type === "text" ? piece.value : ""), extraText]
      .join("\n\n")
      .trim();
    if (!text) return;
    sendToAgent({
      label: "Project gist",
      prompt: `Project gist:\n\n${text}`,
      source: { type: "gist", label: "Project gist" },
    });
    setSent(true);
  };

  const resizeTextArea = (element: HTMLTextAreaElement) => {
    element.style.height = "32px";
    element.style.height = `${Math.min(element.scrollHeight, 96)}px`;
  };

  useEffect(() => {
    if (textAreaRef.current) resizeTextArea(textAreaRef.current);
  }, [textDraft]);

  return (
    <div className="relative" ref={rootRef}>
      <Tooltip align="end" label={t("gist.open")}>
        <button
          aria-expanded={open}
          aria-label={t("gist.open")}
          className={cn(headerActionClassName(), gist && "text-foreground")}
          onClick={() => (open ? setOpen(false) : createGist())}
          type="button"
        >
          <span className={headerActionIconClassName()}><FileText /></span>
          {gist ? <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" /> : null}
        </button>
      </Tooltip>

      {createPortal(
        <div aria-hidden={!open} className={cn("fixed bottom-0 right-0 z-[80] flex w-96 max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden border-l border-border bg-card shadow-xl will-change-transform transition-transform duration-300 ease-out motion-reduce:transition-none", open ? "translate-x-0" : "pointer-events-none translate-x-full")} data-gist-panel style={{ top: isTauri() ? 32 : 0 }}>
          <div className="flex h-10 items-center justify-between border-b border-border px-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <FileText aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold">{t("gist.title")}</span>
              {scopedPieces.length ? <span className="font-mono text-[10px] text-muted-foreground">{scopedPieces.length}</span> : null}
            </div>
            <button aria-label={t("common.close")} className="grid size-6 shrink-0 place-items-center text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)} type="button">
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
            {scopedPieces.map(({ piece, projectLabel, projectPath, scopeKey: pieceScopeKey }, index) => {
              const row = (
                <div className="group px-3 py-2 transition-colors hover:bg-muted/20" data-gist-piece-id={piece.id}>
                {projectLabel ? (
                  <Badge
                    appearance="outline"
                    className="mb-1.5 max-w-full font-normal"
                    label={projectLabel}
                    size="small"
                    title={projectPath ?? projectLabel}
                    variant="secondary"
                  />
                ) : null}
                {piece.type === "text" ? (
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed">{piece.value}</p>
                ) : (
                  <div>
                    <img alt={piece.name || t("gist.imageAlt", { n: index + 1 })} className="max-h-40 max-w-full rounded-md object-contain" src={piece.value} />
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground"><FileImage className="size-3" />{piece.name}</div>
                  </div>
                )}
                <div className="mt-1.5 flex justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
                  <button
                    aria-label={t("gist.sendToAi")}
                    className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35"
                    data-gist-piece-send={piece.id}
                    disabled={piece.type !== "text"}
                    onClick={() => sendPiece(piece)}
                    title={t("gist.sendToAi")}
                    type="button"
                  >
                    <Send aria-hidden="true" className="size-3.5" />
                  </button>
                  <button
                    aria-label={t("gist.removePiece")}
                    className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-gist-piece-delete={piece.id}
                    onClick={() => removePiece(piece.id, pieceScopeKey)}
                    title={t("gist.removePiece")}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              </div>
              );
              return (
                <AiContextTarget
                  key={`${pieceScopeKey}:${piece.id}`}
                  target={{
                    label: piece.type === "text" ? "Gist note" : (piece.name || t("gist.imageAlt", { n: index + 1 })),
                    intents: piece.type === "text" ? [{
                      id: `gist-note-${piece.id}`,
                      label: "Gist note",
                      resolvePrompt: () => piece.value,
                      source: { type: "gist", label: "Gist note" },
                    }] : [],
                    actions: [{
                      id: `remove-gist-piece-${piece.id}`,
                      label: t("gist.removePiece"),
                      icon: <Trash2 aria-hidden="true" className="mr-2 size-4" />,
                      destructive: true,
                      onSelect: () => removePiece(piece.id, pieceScopeKey),
                    }],
                  }}
                >
                  {row}
                </AiContextTarget>
              );
            })}
            {!scopedPieces.length ? <p className="px-3 py-5 text-center text-[11px] text-muted-foreground">{t("gist.empty")}</p> : null}
          </div>

          <div className="flex items-end gap-1.5 border-t border-border bg-muted/10 p-2">
            <textarea
              aria-label={t("gist.newText")}
              className="h-8 min-h-8 max-h-24 flex-1 resize-none overflow-hidden rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] leading-relaxed outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); addImageFiles(event.dataTransfer.files); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  addTextPiece();
                }
              }}
              onChange={(event) => setTextDraft(event.target.value)}
              onPaste={(event) => {
                const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"))?.getAsFile();
                if (image) { event.preventDefault(); addImagePiece(image); }
              }}
              placeholder={t("gist.messagePlaceholder")}
              ref={textAreaRef}
              value={textDraft}
            />
            <input accept="image/*" className="hidden" onChange={(event) => { addImagePiece(event.target.files?.[0]); event.currentTarget.value = ""; }} ref={imageInputRef} type="file" />
            <button aria-label={t("gist.addImage")} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => imageInputRef.current?.click()} title={t("gist.addImage")} type="button">
              <ImagePlus aria-hidden="true" className="size-4" />
            </button>
            <button aria-label={t("gist.send")} className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40" disabled={!gist?.pieces.some((piece) => piece.type === "text" && piece.value.trim()) && !textDraft.trim()} onClick={() => { sendGist(textDraft.trim()); if (textDraft.trim()) addTextPiece(); }} title={sent ? t("gist.sent") : t("gist.send")} type="button">
              <Send aria-hidden="true" className="size-3.5" />
            </button>
          </div>
          {imageError ? <div className="px-2.5 pb-2 text-[10px] text-destructive">{imageError}</div> : null}
        </div>,
        document.body,
      )}
    </div>
  );
}
