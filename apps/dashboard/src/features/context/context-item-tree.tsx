import { useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, Star } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ContextItem, } from "@/lib/api";
import { key, kindDot } from "./context-refs";

/**
 * The context library's list: pinned entries, and markdown files grouped into
 * the folders they sit in on disk.
 *
 * Split from `context-view.tsx`, which owns the selection, the editor and the
 * graph. The tree renders items and reports clicks.
 */

export interface MarkdownFolder {
  name: string;
  path: string;
  folders: MarkdownFolder[];
  files: ContextItem[];
}

export function ContextItemTree({
  items,
  onSelect,
  query,
  selected,
}: {
  items: ContextItem[];
  onSelect: (item: ContextItem) => void;
  query: string;
  selected: ContextItem | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const entities = items.filter((item) => item.kind !== "file");
  const files = items.filter((item) => item.kind === "file");
  const projectTitles = new Map<string, string>();
  for (const item of items) {
    if (item.kind === "project" && item.projectPath) projectTitles.set(item.projectPath, item.title);
  }
  const filesByProject = new Map<string, ContextItem[]>();
  for (const item of files) {
    const projectPath = item.projectPath ?? "";
    filesByProject.set(projectPath, [...(filesByProject.get(projectPath) ?? []), item]);
  }
  const projectGroups = [...filesByProject.entries()].sort(([left], [right]) => left.localeCompare(right));

  function toggleFolder(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <>
      {entities.map((item) => (
        <ContextItemRow item={item} key={key(item.ref)} onSelect={onSelect} selected={selected} />
      ))}
      {files.length ? (
        <section className="border-t border-border">
          <header className="flex items-center gap-1.5 border-b border-border/70 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
            <Folder aria-hidden="true" className="size-3" />
            <span className="min-w-0 flex-1 truncate">{t("context.projectMarkdown")}</span>
            <span className="font-mono font-normal tabular-nums">{t("context.markdownIndexed", { count: files.length })}</span>
          </header>
          {projectGroups.map(([projectPath, projectFiles]) => {
            const tree = buildMarkdownTree(projectFiles, projectPath);
            return (
              <div key={projectPath || "workspace"}>
                {projectGroups.length > 1 ? (
                  <div className="truncate border-b border-border/50 bg-muted/15 px-3 py-1 font-mono text-[9px] text-muted-foreground" title={projectPath}>
                    {projectTitles.get(projectPath) ?? projectPath ?? t("context.workspaceFiles")}
                  </div>
                ) : null}
                <MarkdownTreeFolder
                  expanded={expanded}
                  folder={tree}
                  forceExpanded={Boolean(query)}
                  onSelect={onSelect}
                  onToggle={toggleFolder}
                  selected={selected}
                />
              </div>
            );
          })}
        </section>
      ) : null}
    </>
  );
}

export function ContextItemRow({
  item,
  onSelect,
  selected,
}: {
  item: ContextItem;
  onSelect: (item: ContextItem) => void;
  selected: ContextItem | null;
}) {
  const t = useT();
  return (
    <button className={cn("flex w-full items-start gap-2 border-b border-border/70 px-3 py-2 text-left hover:bg-muted/20", selected && key(item.ref) === key(selected.ref) && "bg-muted/45")} onClick={() => onSelect(item)} type="button">
      <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", kindDot(item.kind))} />
      <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="truncate text-xs font-medium">{item.title}</span>{item.pinned ? <Star aria-label={t("context.pinned")} className="size-3 fill-current text-amber-500" /> : null}</span><span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">{item.kind}{item.excerpt ? ` · ${item.excerpt}` : ""}</span></span>
    </button>
  );
}

export function MarkdownTreeFolder({
  expanded,
  folder,
  forceExpanded,
  onSelect,
  onToggle,
  selected,
  depth = 0,
}: {
  expanded: Set<string>;
  folder: MarkdownFolder;
  forceExpanded: boolean;
  onSelect: (item: ContextItem) => void;
  onToggle: (path: string) => void;
  selected: ContextItem | null;
  depth?: number;
}) {
  const t = useT();
  return (
    <>
      {folder.folders.map((child) => {
        const open = forceExpanded || expanded.has(child.path);
        return (
          <div key={child.path}>
            <button
              aria-expanded={open}
              className="flex h-7 w-full items-center gap-1 border-b border-border/40 pr-2 text-left text-[11px] text-muted-foreground hover:bg-muted/20 hover:text-foreground"
              onClick={() => onToggle(child.path)}
              style={{ paddingLeft: 8 + depth * 12 }}
              type="button"
            >
              <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
              {open ? <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" /> : <Folder aria-hidden="true" className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate" title={child.path}>{child.name}</span>
              <span className="font-mono text-[9px] tabular-nums">{countMarkdownFiles(child)}</span>
            </button>
            {open ? (
              <MarkdownTreeFolder
                depth={depth + 1}
                expanded={expanded}
                folder={child}
                forceExpanded={forceExpanded}
                onSelect={onSelect}
                onToggle={onToggle}
                selected={selected}
              />
            ) : null}
          </div>
        );
      })}
      {folder.files.map((item) => (
        <button
          className={cn("flex h-7 w-full items-center gap-1.5 border-b border-border/40 pr-2 text-left hover:bg-muted/20", selected && key(item.ref) === key(selected.ref) && "bg-muted/45")}
          key={key(item.ref)}
          onClick={() => onSelect(item)}
          style={{ paddingLeft: 22 + depth * 12 }}
          title={item.title}
          type="button"
        >
          <FileText aria-hidden="true" className="size-3.5 shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{item.title.split(/[\\/]/).at(-1)}</span>
          {item.pinned ? <Star aria-label={t("context.pinned")} className="size-3 shrink-0 fill-current text-amber-500" /> : null}
        </button>
      ))}
    </>
  );
}

export function buildMarkdownTree(items: ContextItem[], rootPath: string): MarkdownFolder {
  interface MutableFolder {
    name: string;
    path: string;
    folders: Map<string, MutableFolder>;
    files: ContextItem[];
  }
  const root: MutableFolder = { name: "", path: rootPath, folders: new Map(), files: [] };
  for (const item of items) {
    const parts = item.title.split(/[\\/]/).filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    let current = root;
    for (const part of parts) {
      const path = current.path ? `${current.path}/${part}` : part;
      let child = current.folders.get(part);
      if (!child) {
        child = { name: part, path, folders: new Map(), files: [] };
        current.folders.set(part, child);
      }
      current = child;
    }
    current.files.push(item);
  }
  function finalize(folder: MutableFolder): MarkdownFolder {
    return {
      name: folder.name,
      path: folder.path,
      folders: [...folder.folders.values()].sort((left, right) => left.name.localeCompare(right.name)).map(finalize),
      files: folder.files.sort((left, right) => left.title.localeCompare(right.title)),
    };
  }
  return finalize(root);
}

export function countMarkdownFiles(folder: MarkdownFolder): number {
  return folder.files.length + folder.folders.reduce((total, child) => total + countMarkdownFiles(child), 0);
}

