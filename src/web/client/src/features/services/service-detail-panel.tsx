import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { ComposerDialog } from "./service-forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToasts } from "@/components/ui/toast";
import {
  browseServiceConfig,
  getServiceConfigFile,
  getServiceConfigFiles,
  getServiceLogs,
  postForm,
  putServiceConfigFileEnv,
  putServiceConfigFileText,
  type ConfigBrowseEntry,
  type ConfigBrowseResult,
  type ConfigFileInfo,
  type LogEntry,
  type ProcessRow,
  type ServiceEnvEntry,
  type ServiceHealth,
  type ServiceStatus,
  type TimelineEvent,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Tab = "processes" | "http" | "env" | "logs";

export function ServiceDetailPanel({
  serviceName,
  status,
  health,
  timeline,
  onRefresh,
}: {
  serviceName: string;
  status?: ServiceStatus;
  health?: ServiceHealth;
  timeline: TimelineEvent[];
  onRefresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("processes");
  const processes = health?.processTree?.processes ?? [];

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="mb-2 flex gap-1">
        <TabButton active={tab === "processes"} onClick={() => setTab("processes")}>
          Processes {processes.length ? <Badge variant="secondary" size="small">{processes.length}</Badge> : null}
        </TabButton>
        <TabButton active={tab === "http"} onClick={() => setTab("http")}>
          HTTP
          {status?.inspector?.enabled ? (
            <Badge variant="success" size="small">on</Badge>
          ) : null}
        </TabButton>
        <TabButton active={tab === "env"} onClick={() => setTab("env")}>
          Env
        </TabButton>
        <TabButton active={tab === "logs"} onClick={() => setTab("logs")}>
          Logs
        </TabButton>
      </div>
      {tab === "processes" ? <ProcessesTab rows={processes} /> : null}
      {tab === "http" ? (
        <HttpTab
          serviceName={serviceName}
          status={status}
          timeline={timeline}
          onRefresh={onRefresh}
        />
      ) : null}
      {tab === "env" ? <EnvTab serviceName={serviceName} /> : null}
      {tab === "logs" ? <LogsTab serviceName={serviceName} /> : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function ProcessesTab({ rows }: { rows: ProcessRow[] }) {
  if (rows.length === 0) {
    return <div className="text-muted-foreground">No process tree (service not running).</div>;
  }
  const sorted = [...rows].sort((a, b) => b.cpuPercent - a.cpuPercent);
  const pidSet = new Set(rows.map((row) => row.pid));
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-3">PID</th>
            <th className="py-1 pr-3">PPID</th>
            <th className="py-1 pr-3 text-right">CPU%</th>
            <th className="py-1 pr-3 text-right">RSS MB</th>
            <th className="py-1">Command</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const isChild = pidSet.has(row.ppid);
            return (
              <tr key={row.pid} className="border-t border-border/40">
                <td className="py-1 pr-3">{row.pid}</td>
                <td className="py-1 pr-3 text-muted-foreground">{row.ppid}</td>
                <td className="py-1 pr-3 text-right">{row.cpuPercent.toFixed(1)}</td>
                <td className="py-1 pr-3 text-right">{row.rssMb.toFixed(1)}</td>
                <td className={cn("py-1 truncate max-w-[60ch]", isChild && "pl-4")}>
                  {row.command}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface HttpRow {
  id: string;
  startedAt: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  reqBytes: number;
  resBytes: number;
}

function HttpTab({
  serviceName,
  status,
  timeline,
  onRefresh,
}: {
  serviceName: string;
  status?: ServiceStatus;
  timeline: TimelineEvent[];
  onRefresh: () => Promise<void>;
}) {
  const { error: showError, success: showSuccess } = useToasts();
  const [busy, setBusy] = useState(false);
  const inspector = status?.inspector;
  const running = status?.state === "running";

  const rows = useMemo<HttpRow[]>(() => {
    return timeline
      .filter((event) => event.kind === "service.http" && event.service === serviceName)
      .map((event) => {
        const data = (event.data ?? {}) as Partial<HttpRow>;
        return {
          id: (data.id as string) ?? event.id,
          startedAt: event.timestamp,
          method: (data.method as string) ?? "?",
          path: (data.path as string) ?? "?",
          status: (data.status as number) ?? 0,
          durationMs: (data.durationMs as number) ?? 0,
          reqBytes: (data.reqBytes as number) ?? 0,
          resBytes: (data.resBytes as number) ?? 0,
        };
      })
      .slice(-500)
      .reverse();
  }, [timeline, serviceName]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      await postForm(
        `/api/services/${encodeURIComponent(serviceName)}/inspector`,
        { enabled: enabled ? "true" : "false" },
      );
      await onRefresh();
      showSuccess(
        enabled ? `HTTP inspector started for ${serviceName}.` : `HTTP inspector stopped for ${serviceName}.`,
      );
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!running) {
    return <div className="text-muted-foreground">Service is not running.</div>;
  }

  if (!inspector?.enabled) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground">
          The HTTP inspector starts a local proxy that forwards traffic to this service and
          records every request. Hit the inspect URL instead of the original port to see
          requests appear here. The service itself is not touched.
        </p>
        <Button disabled={busy} onClick={() => toggle(true)} size="sm" type="button">
          <Play /> Start HTTP inspector
        </Button>
      </div>
    );
  }

  const inspectUrl = inspector.port ? `http://127.0.0.1:${inspector.port}` : undefined;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Inspect URL:</span>
        {inspectUrl ? (
          <>
            <code className="rounded bg-background px-1.5 py-0.5 font-mono">{inspectUrl}</code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(inspectUrl);
                showSuccess("Copied inspect URL.");
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Copy /> Copy
            </Button>
            <Button
              onClick={() => window.open(inspectUrl, "_blank", "noopener,noreferrer")}
              size="sm"
              type="button"
              variant="outline"
            >
              Open
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground">starting…</span>
        )}
        <span className="text-muted-foreground">
          → upstream :{inspector.upstreamPort ?? "?"}
        </span>
        <Button disabled={busy} onClick={() => toggle(false)} size="sm" type="button" variant="outline">
          <Square /> Stop
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground">
          No requests captured yet. Hit the inspect URL in your browser to see traffic.
        </div>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 bg-muted/60 text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Time</th>
                <th className="py-1 pr-3">Method</th>
                <th className="py-1 pr-3">Path</th>
                <th className="py-1 pr-3 text-right">Status</th>
                <th className="py-1 pr-3 text-right">Size</th>
                <th className="py-1 pr-3 text-right">ms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border/40">
                  <td className="py-1 pr-3 text-muted-foreground">
                    {new Date(row.startedAt).toLocaleTimeString()}
                  </td>
                  <td className="py-1 pr-3">{row.method}</td>
                  <td className="py-1 pr-3 truncate max-w-[40ch]">{row.path}</td>
                  <td className={cn("py-1 pr-3 text-right", statusColor(row.status))}>
                    {row.status}
                  </td>
                  <td className="py-1 pr-3 text-right text-muted-foreground">
                    {formatBytes(row.resBytes)}
                  </td>
                  <td className="py-1 pr-3 text-right">{row.durationMs.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function statusColor(status: number): string {
  if (status >= 500) return "text-red-600 dark:text-red-400";
  if (status >= 400) return "text-amber-600 dark:text-amber-400";
  if (status >= 300) return "text-zinc-500";
  if (status >= 200) return "text-emerald-600 dark:text-emerald-400";
  return "text-muted-foreground";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface EnvRow extends ServiceEnvEntry {
  reveal: boolean;
}

interface LoadedFile {
  info: ConfigFileInfo;
  exists: boolean;
  rows?: EnvRow[];
  text?: string;
}

function EnvTab({ serviceName }: { serviceName: string }) {
  const { error: showError, success: showSuccess } = useToasts();
  const [files, setFiles] = useState<ConfigFileInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [loaded, setLoaded] = useState<LoadedFile | undefined>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [revealAll, setRevealAll] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setError(undefined);
    void (async () => {
      try {
        const result = await getServiceConfigFiles(serviceName);
        if (cancelled) return;
        setFiles(result.files);
        if (result.files.length > 0) {
          setSelectedPath((current) => current ?? result.files[0].path);
        } else {
          setSelectedPath(undefined);
          setLoaded(undefined);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceName]);

  const loadFile = useCallback(
    async (path: string) => {
      setLoadingFile(true);
      setError(undefined);
      try {
        const result = await getServiceConfigFile(serviceName, path);
        const info: ConfigFileInfo = {
          path: result.path,
          relativePath: result.relativePath,
          format: result.format,
        };
        if (result.format === "env") {
          setLoaded({
            info,
            exists: result.exists,
            rows: result.entries.map((entry) => ({ ...entry, reveal: false })),
          });
        } else {
          setLoaded({
            info,
            exists: result.exists,
            text: result.format === "json" ? prettyJson(result.content) : result.content,
          });
        }
        setDirty(false);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoadingFile(false);
      }
    },
    [serviceName],
  );

  useEffect(() => {
    if (selectedPath) void loadFile(selectedPath);
  }, [selectedPath, loadFile]);

  function updateRow(index: number, patch: Partial<EnvRow>) {
    setLoaded((current) => {
      if (!current?.rows) return current;
      const rows = current.rows.map((row, idx) => (idx === index ? { ...row, ...patch } : row));
      return { ...current, rows };
    });
    setDirty(true);
  }

  function addRow() {
    setLoaded((current) => {
      if (!current?.rows) return current;
      return {
        ...current,
        rows: [...current.rows, { key: "", value: "", secret: false, reveal: true }],
      };
    });
    setDirty(true);
  }

  function removeRow(index: number) {
    setLoaded((current) => {
      if (!current?.rows) return current;
      return { ...current, rows: current.rows.filter((_, idx) => idx !== index) };
    });
    setDirty(true);
  }

  function updateText(text: string) {
    setLoaded((current) => (current ? { ...current, text } : current));
    setDirty(true);
  }

  async function save() {
    if (!loaded) return;
    setSaving(true);
    try {
      if (loaded.info.format === "env" && loaded.rows) {
        const result = await putServiceConfigFileEnv(
          serviceName,
          loaded.info.path,
          loaded.rows.map((row) => ({ key: row.key.trim(), value: row.value })),
        );
        setLoaded({
          info: { path: result.path, relativePath: result.relativePath, format: result.format },
          exists: result.exists,
          rows: result.entries.map((entry) => ({ ...entry, reveal: false })),
        });
        showSuccess(`Saved ${result.entries.length} entries to ${result.relativePath}.`);
      } else if (loaded.text !== undefined) {
        const result = await putServiceConfigFileText(
          serviceName,
          loaded.info.path,
          loaded.text,
        );
        setLoaded({
          info: { path: result.path, relativePath: result.relativePath, format: result.format },
          exists: result.exists,
          text: result.content,
        });
        showSuccess(`Saved ${result.relativePath}.`);
      }
      setDirty(false);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function pickFile(relativePath: string) {
    try {
      const result = await getServiceConfigFile(serviceName, relativePath);
      const info: ConfigFileInfo = {
        path: result.path,
        relativePath: result.relativePath,
        format: result.format,
      };
      setFiles((current) =>
        current.some((file) => file.path === info.path) ? current : [...current, info],
      );
      setSelectedPath(info.path);
      setBrowserOpen(false);
      showSuccess(`Loaded ${info.relativePath}.`);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  if (loadingList) {
    return <div className="text-muted-foreground">Loading…</div>;
  }
  if (error && !loaded) {
    return <div className="text-red-600">{error}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">File:</span>
          {files.length > 0 ? (
            <select
              className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-xs"
              onChange={(event) => setSelectedPath(event.target.value)}
              value={selectedPath ?? ""}
            >
              {files.map((file) => (
                <option key={file.path} value={file.path}>
                  {file.relativePath} [{file.format}]
                </option>
              ))}
            </select>
          ) : (
            <span className="text-muted-foreground">none detected</span>
          )}
          <Button
            onClick={() => setBrowserOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <FolderOpen /> Browse files
          </Button>
          {loaded ? (
            <code className="rounded bg-background px-1.5 py-0.5 font-mono text-muted-foreground">
              {loaded.info.path}
            </code>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {loaded?.info.format === "env" ? (
            <>
              <Button onClick={() => setRevealAll((value) => !value)} size="sm" type="button" variant="outline">
                {revealAll ? <EyeOff /> : <Eye />}
                {revealAll ? "Hide secrets" : "Reveal secrets"}
              </Button>
              <Button onClick={addRow} size="sm" type="button" variant="outline">
                <Plus /> Add
              </Button>
            </>
          ) : null}
          <Button disabled={!dirty || saving || !loaded} onClick={save} size="sm" type="button">
            <Save /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {error && !loaded ? (
        <div className="text-red-600">{error}</div>
      ) : loaded?.info.format === "env" && loaded.rows ? (
        <div className={cn(loadingFile && "opacity-60 transition-opacity")}>
          <EnvTable
            revealAll={revealAll}
            rows={loaded.rows}
            onAdd={addRow}
            onRemove={removeRow}
            onUpdate={updateRow}
          />
        </div>
      ) : loaded?.text !== undefined ? (
        <div className={cn("space-y-1", loadingFile && "opacity-60 transition-opacity")}>
          {loaded.info.format === "json" ? (
            <div className="flex justify-end">
              <Button
                onClick={() => updateText(prettyJson(loaded.text ?? ""))}
                size="sm"
                type="button"
                variant="outline"
              >
                Format JSON
              </Button>
            </div>
          ) : null}
          <textarea
            className="min-h-[300px] w-full rounded border border-border/60 bg-background p-2 font-mono text-[11px] leading-relaxed"
            onChange={(event) => updateText(event.target.value)}
            spellCheck={false}
            value={loaded.text}
          />
        </div>
      ) : loadingFile ? (
        <div className="text-muted-foreground">Loading file…</div>
      ) : null}
      {loaded ? (
        <p className="text-muted-foreground">
          {loaded.info.format === "env"
            ? "Comments and blank lines are preserved."
            : loaded.info.format === "json"
              ? "JSON is validated on save."
              : "YAML is saved as raw text."}{" "}
          The running process won't see changes until you restart it.
        </p>
      ) : null}
      {browserOpen ? (
        <FileBrowserDialog
          onClose={() => setBrowserOpen(false)}
          onPick={pickFile}
          serviceName={serviceName}
        />
      ) : null}
    </div>
  );
}

function prettyJson(text: string): string {
  if (!text.trim()) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function FileBrowserDialog({
  serviceName,
  onClose,
  onPick,
}: {
  serviceName: string;
  onClose: () => void;
  onPick: (relativePath: string) => void;
}) {
  const [data, setData] = useState<ConfigBrowseResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const result = await browseServiceConfig(serviceName, path);
        if (!cancelled) setData(result);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceName, path]);

  function enter(entry: ConfigBrowseEntry) {
    if (entry.kind === "directory") {
      setPath(entry.relativePath);
      return;
    }
    if (!entry.supported) return;
    onPick(entry.relativePath);
  }

  function goUp() {
    if (!data || data.isRoot) return;
    const rel = data.relativePath;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    setPath(parent || undefined);
  }

  return (
    <ComposerDialog
      icon={<FolderOpen />}
      onClose={onClose}
      size="lg"
      title="Pick a config file"
    >
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-xs">
          <Button
            disabled={!data || data.isRoot}
            onClick={goUp}
            size="sm"
            type="button"
            variant="outline"
          >
            <ChevronUp /> Up
          </Button>
          <code className="truncate rounded bg-muted px-2 py-1 font-mono">
            {data?.relativePath || "./"}
          </code>
        </div>
        {error ? (
          <div className="text-red-600">{error}</div>
        ) : loading ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : !data || data.entries.length === 0 ? (
          <div className="text-muted-foreground">Empty directory.</div>
        ) : (
          <div className="max-h-[50vh] overflow-auto rounded border border-border/60">
            <ul className="divide-y divide-border/40">
              {data.entries.map((entry) => {
                const isDir = entry.kind === "directory";
                const clickable = isDir || entry.supported;
                return (
                  <li key={entry.relativePath}>
                    <button
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                        clickable ? "hover:bg-muted" : "cursor-not-allowed text-muted-foreground",
                      )}
                      disabled={!clickable}
                      onClick={() => enter(entry)}
                      type="button"
                    >
                      {isDir ? <Folder size={14} /> : <FileIcon size={14} />}
                      <span className="flex-1 truncate font-mono">{entry.name}</span>
                      {!isDir && entry.format ? (
                        <Badge size="small" variant="secondary">
                          {entry.format}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Only <code>.env*</code>, <code>appsettings*.json</code>, and{" "}
          <code>application*.yml</code> can be selected. Other files are shown disabled.
        </p>
      </div>
    </ComposerDialog>
  );
}

function EnvTable({
  rows,
  revealAll,
  onAdd,
  onRemove,
  onUpdate,
}: {
  rows: EnvRow[];
  revealAll: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<EnvRow>) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground">
        No variables yet.{" "}
        <button className="underline" onClick={onAdd} type="button">
          Add one
        </button>
        .
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-3">Key</th>
            <th className="py-1 pr-3">Value</th>
            <th className="py-1 w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const masked = !row.reveal && !revealAll;
            return (
              <tr key={index} className="border-t border-border/40">
                <td className="py-1 pr-3 align-top">
                  <input
                    className="w-full rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono"
                    onChange={(event) => onUpdate(index, { key: event.target.value })}
                    placeholder="KEY"
                    spellCheck={false}
                    value={row.key}
                  />
                </td>
                <td className="py-1 pr-3 align-top">
                  <div className="flex items-center gap-1">
                    <input
                      className="w-full rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono"
                      onChange={(event) => onUpdate(index, { value: event.target.value })}
                      spellCheck={false}
                      type={masked ? "password" : "text"}
                      value={row.value}
                    />
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => onUpdate(index, { reveal: !row.reveal })}
                      title={row.reveal || revealAll ? "Hide" : "Reveal"}
                      type="button"
                    >
                      {row.reveal || revealAll ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </td>
                <td className="py-1 align-top">
                  <button
                    className="text-muted-foreground hover:text-red-600"
                    onClick={() => onRemove(index)}
                    type="button"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LogsTab({ serviceName }: { serviceName: string }) {
  const [logs, setLogs] = useState<LogEntry[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getServiceLogs(serviceName);
        if (!cancelled) setLogs(result);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    const id = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [serviceName]);

  if (error) {
    return <div className="text-red-600">{error}</div>;
  }
  if (!logs) {
    return <div className="text-muted-foreground">Loading…</div>;
  }
  if (logs.length === 0) {
    return <div className="text-muted-foreground">No log entries.</div>;
  }
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px]">
      {logs.map((entry) => `${new Date(entry.timestamp).toLocaleTimeString()} [${entry.stream}] ${entry.text}`).join("\n")}
    </pre>
  );
}
