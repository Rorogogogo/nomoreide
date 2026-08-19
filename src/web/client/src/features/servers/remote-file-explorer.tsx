import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Eye,
  EyeOff,
  FileQuestion,
  Folder,
  FolderOpen,
  FolderUp,
  Link2,
  RefreshCw,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/cvui-badge";
import { Loading } from "@/components/ui/loading";
import {
  getRemoteFile,
  listRemoteDirectory,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { FileKindIcon } from "../git/file-kind-icon";

export function RemoteFileExplorer({
  host,
  label,
  onBack,
}: {
  host: string;
  label: string;
  onBack: () => void;
}) {
  const t = useT();
  const readDirectory = useCallback(
    (path: string, includeHidden: boolean) => listRemoteDirectory(host, path, includeHidden),
    [host],
  );
  const readFile = useCallback((path: string) => getRemoteFile(host, path), [host]);
  return (
    <ReadOnlyFileExplorer
      backLabel={t("servers.filesBack")}
      label={label}
      onBack={onBack}
      readDirectory={readDirectory}
      readFile={readFile}
      title={t("servers.filesTitle")}
    />
  );
}

interface FileEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
}

interface DirectoryListing {
  path: string;
  entries: FileEntry[];
}

interface FileContent {
  path: string;
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

/** Shared lazy tree/preview surface; SSH and Docker supply only transport adapters. */
export function ReadOnlyFileExplorer({
  backLabel,
  label,
  onBack,
  readDirectory,
  readFile,
  title,
}: {
  backLabel: string;
  label: string;
  onBack: () => void;
  readDirectory: (path: string, includeHidden: boolean) => Promise<DirectoryListing>;
  readFile: (path: string) => Promise<FileContent>;
  title: string;
}) {
  const t = useT();
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(0);

  const loadDirectory = useCallback(async (
    path: string,
    epoch = epochRef.current,
    replaceRoot = false,
  ) => {
    setLoadingPaths((current) => new Set(current).add(path));
    setError(null);
    try {
      const directory = await readDirectory(path, showHidden);
      if (epoch !== epochRef.current) return;
      setRootPath((current) => replaceRoot ? directory.path : current ?? directory.path);
      setDirectories((current) => ({ ...current, [directory.path]: directory.entries }));
    } catch (caught) {
      if (epoch === epochRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (epoch === epochRef.current) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  }, [readDirectory, showHidden]);

  useEffect(() => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    setRootPath(null);
    setDirectories({});
    setExpanded(new Set());
    setLoadingPaths(new Set());
    setSelected(null);
    setError(null);
    void loadDirectory(".", epoch, true);
  }, [loadDirectory]);

  function toggleDirectory(path: string) {
    if (expanded.has(path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(path));
    if (directories[path] === undefined) void loadDirectory(path);
  }

  function refresh() {
    navigateRoot(rootPath ?? ".");
  }

  function navigateRoot(path: string) {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    setRootPath(null);
    setDirectories({});
    setExpanded(new Set());
    setLoadingPaths(new Set());
    setSelected(null);
    setError(null);
    void loadDirectory(path, epoch, true);
  }

  const rootEntries = rootPath ? directories[rootPath] : undefined;
  const parentPath = rootPath ? parentRemotePath(rootPath) : null;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <ExplorerIconButton label={backLabel} onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </ExplorerIconButton>
        <Folder aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">{title}</span>
        <span aria-hidden="true" className="text-muted-foreground/50">/</span>
        <span className="min-w-0 truncate font-mono text-[11px]" title={label}>{label}</span>
        <Badge appearance="subtle" size="small" variant="secondary">
          {t("servers.filesReadOnly")}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <ExplorerIconButton
            label={t(showHidden ? "servers.filesHiddenHide" : "servers.filesHiddenShow")}
            onClick={() => setShowHidden((current) => !current)}
          >
            {showHidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </ExplorerIconButton>
          <ExplorerIconButton label={t("servers.filesRefresh")} onClick={refresh}>
            <RefreshCw aria-hidden="true" />
          </ExplorerIconButton>
        </div>
      </header>

      {error ? (
        <Alert aria-live="polite" className="m-3 shrink-0" variant="destructive">
          {error}
        </Alert>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] max-sm:grid-cols-[minmax(9rem,44vw)_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col overflow-hidden border-r border-border">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/95 px-2.5 py-1.5">
            <span className="min-w-0 truncate font-mono text-[10px] font-medium" title={rootPath ?? undefined}>
              {rootPath ?? label}
            </span>
            <Badge variant="secondary" size="small">{rootEntries?.length ?? 0}</Badge>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {!rootPath || rootEntries === undefined ? (
              <Loading className="h-full" label={t("servers.filesLoading")} />
            ) : (
              <>
                {parentPath ? (
                  <button
                    aria-label={t("servers.filesParent")}
                    className="flex w-full items-center gap-1.5 px-1 py-0.5 text-left font-mono text-[12px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                    onClick={() => navigateRoot(parentPath)}
                    title={parentPath}
                    type="button"
                  >
                    <FolderUp aria-hidden="true" className="size-3.5 shrink-0 text-amber-600" />
                    <span>..</span>
                    <span className="min-w-0 flex-1 truncate text-[9px]">{parentPath}</span>
                  </button>
                ) : null}
                {rootEntries.length === 0 ? (
                  <Alert className="m-3 text-center" variant="muted">{t("servers.filesEmpty")}</Alert>
                ) : (
                  rootEntries.map((entry) => (
                    <RemoteTreeRow
                      directories={directories}
                      entry={entry}
                      expanded={expanded}
                      key={entry.path}
                      loadingPaths={loadingPaths}
                      onSelect={setSelected}
                      onToggle={toggleDirectory}
                      selectedPath={selected?.path ?? ""}
                    />
                  ))
                )}
              </>
            )}
          </div>
        </aside>
        <RemoteFilePreview entry={selected} readFile={readFile} />
      </div>
    </div>
  );
}

function RemoteTreeRow({
  directories,
  entry,
  expanded,
  loadingPaths,
  onSelect,
  onToggle,
  selectedPath,
  depth = 0,
}: {
  directories: Record<string, FileEntry[]>;
  entry: FileEntry;
  expanded: Set<string>;
  loadingPaths: Set<string>;
  onSelect: (entry: FileEntry) => void;
  onToggle: (path: string) => void;
  selectedPath: string;
  depth?: number;
}) {
  const t = useT();
  const isDirectory = entry.type === "directory";
  const isOpen = expanded.has(entry.path);
  const children = directories[entry.path];
  const loading = loadingPaths.has(entry.path);
  const paddingLeft = 6 + depth * 12;

  if (!isDirectory) {
    return (
      <button
        className={cn(
          "flex w-full items-center gap-1.5 px-1 py-0.5 text-left text-[12px] hover:bg-muted/40",
          selectedPath === entry.path && "bg-muted/45 font-medium",
        )}
        onClick={() => onSelect(entry)}
        style={{ paddingLeft: paddingLeft + 14 }}
        title={entry.type === "symlink" ? t("servers.filesSymlink") : entry.path}
        type="button"
      >
        {entry.type === "file" ? (
          <FileKindIcon path={entry.path} />
        ) : entry.type === "symlink" ? (
          <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileQuestion aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
    );
  }

  const Chevron = isOpen ? ChevronDown : ChevronRight;
  const FolderIcon = isOpen ? FolderOpen : Folder;
  return (
    <div>
      <button
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1 py-0.5 text-left text-[12px] font-medium hover:bg-muted/40"
        onClick={() => onToggle(entry.path)}
        style={{ paddingLeft }}
        type="button"
      >
        <Chevron aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground", loading && "animate-pulse motion-reduce:animate-none")} />
        <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-amber-600" />
        <span className="min-w-0 flex-1 truncate" title={entry.path}>{entry.name}</span>
      </button>
      {isOpen
        ? children?.map((child) => (
            <RemoteTreeRow
              depth={depth + 1}
              directories={directories}
              entry={child}
              expanded={expanded}
              key={child.path}
              loadingPaths={loadingPaths}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedPath={selectedPath}
            />
          ))
        : null}
    </div>
  );
}

function RemoteFilePreview({
  entry,
  readFile,
}: {
  entry: FileEntry | null;
  readFile: (path: string) => Promise<FileContent>;
}) {
  const t = useT();
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!entry || entry.type !== "file") {
      setFile(null);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void readFile(entry.path)
      .then((next) => {
        if (active) setFile(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [entry, readFile]);

  if (!entry) {
    return <div className="grid min-h-0 place-items-center p-4 text-xs text-muted-foreground">{t("servers.filesSelect")}</div>;
  }
  if (entry.type !== "file") {
    return <div className="grid min-h-0 place-items-center p-4 text-xs text-muted-foreground">{t("servers.filesUnsupported")}</div>;
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
        <FileKindIcon path={entry.path} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium" title={entry.path}>
          {entry.path}
        </span>
        <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
          {formatBytes(entry.size)}
        </span>
        <ExplorerIconButton
          label={t("servers.filesCopyPath")}
          onClick={() => void navigator.clipboard?.writeText(entry.path)}
        >
          <Clipboard aria-hidden="true" />
        </ExplorerIconButton>
      </div>
      {loading ? (
        <Loading className="flex-1" label={t("servers.filesLoading")} />
      ) : error ? (
        <Alert className="m-3" variant="destructive">{error}</Alert>
      ) : file?.binary ? (
        <div className="grid flex-1 place-items-center p-4 text-xs text-muted-foreground">{t("servers.filesBinary")}</div>
      ) : file ? (
        <>
          {file.truncated ? (
            <div className="shrink-0 border-b border-border bg-muted/20 px-3 py-1.5 text-[10px] text-muted-foreground">
              {t("servers.filesTruncated")}
            </div>
          ) : null}
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-[12px] leading-5 text-foreground">{file.content}</pre>
        </>
      ) : null}
    </section>
  );
}

function ExplorerIconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The next root shown by the explorer's `..` row; `/` has no parent. */
export function parentRemotePath(path: string): string | null {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "/") return null;
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}
