import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileImage, FileText, ImagePlus, Send, Trash2, X } from "lucide-react";
import { useAgentDock } from "@/features/agent/chat/agent-context";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useT } from "@/lib/i18n";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { headerActionClassName, headerActionIconClassName } from "./header-action";
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

/** A small, persistent scratchpad for project notes, text snippets, and images. */
export function GistPopover({ scopeKey = "all" }: { scopeKey?: string }) {
  const t = useT();
  const { sendToAgent } = useAgentDock();
  const [storedGist, setStoredGist] = usePersistentState<GistDraft | null>(`gist:current:${scopeKey}`, null);
  const gist = normalizeGist(storedGist);
  const [open, setOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [sent, setSent] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [pieceMenu, setPieceMenu] = useState<string | null>(null);
  const [pieceMenuPosition, setPieceMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (gist && storedGist && !("pieces" in storedGist)) setStoredGist(gist);
  }, [gist, setStoredGist, storedGist]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest("[data-gist-menu]")) return;
      if (target.closest("[data-gist-panel]")) {
        setPieceMenu(null);
        setPieceMenuPosition(null);
        return;
      }
      if (!rootRef.current?.contains(event.target as Node)) {
        setPieceMenu(null);
        setPieceMenuPosition(null);
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

  const removePiece = (id: string) => {
    updateGist({ pieces: (gist?.pieces ?? []).filter((piece) => piece.id !== id) });
  };

  const sendGist = (extraText = "") => {
    const text = [...(gist?.pieces ?? []).map((piece) => piece.type === "text" ? piece.value : ""), extraText]
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

  const sendPieceToAgent = (piece: GistPiece, mode: "send" | "draft") => {
    if (piece.type !== "text") return;
    sendToAgent({ label: "Gist note", mode, prompt: piece.value, source: { type: "gist", label: "Gist note" } });
    setPieceMenu(null);
    setPieceMenuPosition(null);
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
        <div aria-hidden={!open} className={cn("fixed bottom-0 right-0 z-[80] flex w-96 max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden border-l border-border bg-card shadow-xl will-change-transform transition-transform duration-300 ease-out motion-reduce:transition-none", open ? "translate-x-0" : "pointer-events-none translate-x-full")} data-gist-panel onContextMenu={(event) => { event.preventDefault(); const target = (event.target as Element).closest<HTMLElement>("[data-gist-piece-id]"); const id = target?.dataset.gistPieceId; if (!id) return; setPieceMenu(id); setPieceMenuPosition({ top: Math.min(event.clientY, window.innerHeight - 150), left: Math.min(event.clientX, window.innerWidth - 140) }); }} style={{ top: isTauri() ? 32 : 0 }}>
          <div className="flex h-10 items-center justify-between border-b border-border px-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <FileText aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold">{t("gist.title")}</span>
              {gist?.pieces.length ? <span className="font-mono text-[10px] text-muted-foreground">{gist.pieces.length}</span> : null}
            </div>
            <button aria-label={t("common.close")} className="grid size-6 shrink-0 place-items-center text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)} type="button">
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
            {(gist?.pieces ?? []).map((piece, index) => (
              <div className="group px-3 py-2 transition-colors hover:bg-muted/20" data-gist-piece-id={piece.id} key={piece.id}>
                {piece.type === "text" ? (
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed">{piece.value}</p>
                ) : (
                  <div>
                    <img alt={piece.name || t("gist.imageAlt", { n: index + 1 })} className="max-h-40 max-w-full rounded-md object-contain" src={piece.value} />
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground"><FileImage className="size-3" />{piece.name}</div>
                  </div>
                )}
              </div>
            ))}
            {!(gist?.pieces.length) ? <p className="px-3 py-5 text-center text-[11px] text-muted-foreground">{t("gist.empty")}</p> : null}
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
      {open && pieceMenu && pieceMenuPosition ? createPortal(
        <div className="fixed z-[1100] w-32 rounded-md border border-border bg-card py-1 shadow-lg" data-gist-menu style={{ left: pieceMenuPosition.left, top: pieceMenuPosition.top }}>
          {(() => {
            const piece = gist?.pieces.find((item) => item.id === pieceMenu);
            if (!piece) return null;
            return <>
              <button className="flex w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" data-gist-menu disabled={piece.type !== "text"} onClick={() => sendPieceToAgent(piece, "draft")} type="button">{t("gist.copyToAi")}</button>
              <button className="flex w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" data-gist-menu disabled={piece.type !== "text"} onClick={() => sendPieceToAgent(piece, "send")} type="button">{t("gist.sendToAi")}</button>
              <button className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-destructive hover:bg-muted" data-gist-menu onClick={() => { removePiece(piece.id); setPieceMenu(null); setPieceMenuPosition(null); }} type="button"><Trash2 aria-hidden="true" className="size-3" />{t("gist.removePiece")}</button>
            </>;
          })()}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
