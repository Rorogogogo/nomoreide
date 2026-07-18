import { useEffect, useMemo, useState } from "react";
import { Check, Database, Loader2, Wand2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import { ComposerDialog } from "@/features/services/service-form/composer-dialog";
import {
  addDatabase,
  detectDatabases,
  testDatabase,
  type DatabaseEngine,
  type DetectedConnection,
  type GitRepositoryDefinition,
} from "@/lib/api";
import { pathInScope } from "../services/project-scope";
import {
  buildConnectionUrl,
  engineFromUrl,
  parseConnectionUrl,
  EMPTY_FIELDS,
  type ConnectionFields,
} from "./connection-url";

const ENGINES: { value: DatabaseEngine; label: string }[] = [
  { value: "postgres", label: "Postgres" },
  { value: "mysql", label: "MySQL" },
  { value: "sqlite", label: "SQLite" },
];

type TestState = { status: "idle" | "ok" | "fail"; message?: string };

/** The connection being edited; `url` is the password-masked stored value. */
export interface EditTarget {
  name: string;
  engine: DatabaseEngine;
  url: string;
  projectPath?: string;
}

export function AddConnectionDialog({
  onClose,
  onSaved,
  initial,
  projects = [],
}: {
  onClose: () => void;
  onSaved: () => void;
  initial?: EditTarget;
  /** Registered git projects the connection can be classified under. */
  projects?: GitRepositoryDefinition[];
}) {
  const { error: showError, success: showSuccess } = useToasts();
  const isEditing = Boolean(initial);
  const seed = useMemo(() => seedState(initial), [initial]);
  const [engine, setEngine] = useState<DatabaseEngine>(seed.engine);
  const [name, setName] = useState(seed.name);
  // `url` is the source of truth we submit; the discrete fields stay synced to
  // it both ways (edit a field → rebuild URL; edit the URL → reparse fields).
  const [url, setUrl] = useState(seed.url);
  const [fields, setFields] = useState<ConnectionFields>(seed.fields);
  const [detected, setDetected] = useState<DetectedConnection[]>([]);
  // Repo path the connection is classified under; "" = unassigned/shared.
  const [projectPath, setProjectPath] = useState(initial?.projectPath ?? "");
  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Auto-detect is only useful when creating a fresh connection.
    if (isEditing) return;
    detectDatabases()
      .then(setDetected)
      .catch(() => setDetected([]));
  }, [isEditing]);

  const isSqlite = engine === "sqlite";
  // SQLite submits the raw file path; servers rebuild from fields so the real
  // password (kept out of the visible URL) is spliced back in at connect time.
  const submitUrl = isSqlite ? url.trim() : buildConnectionUrl(engine, fields);
  // `buildConnectionUrl` defaults the host to localhost, so submitUrl is never
  // empty — gate connecting on actual input instead, or an empty form would
  // silently test against the local default Postgres.
  const canConnect = isSqlite
    ? Boolean(url.trim())
    : Boolean(fields.host.trim() && fields.database.trim());

  function resetTest() {
    setTestState({ status: "idle" });
  }

  /** The on-screen URL, with the password omitted. */
  function displayUrl(nextEngine: DatabaseEngine, nextFields: ConnectionFields) {
    return buildConnectionUrl(nextEngine, nextFields, { includePassword: false });
  }

  function changeEngine(next: DatabaseEngine) {
    setEngine(next);
    resetTest();
    // Re-render the URL under the new scheme; SQLite keeps its raw file path.
    if (next !== "sqlite") setUrl(displayUrl(next, fields));
  }

  function changeField(patch: Partial<ConnectionFields>) {
    const next = { ...fields, ...patch };
    setFields(next);
    setUrl(displayUrl(engine, next));
    resetTest();
  }

  function changeUrl(value: string) {
    resetTest();
    const detectedEngine = engineFromUrl(value);
    const activeEngine = detectedEngine ?? engine;
    if (detectedEngine && detectedEngine !== engine) setEngine(detectedEngine);

    const parsed = detectedEngine === "sqlite" ? null : parseConnectionUrl(value);
    if (!parsed) {
      setUrl(value);
      return;
    }
    if (parsed.password) {
      // A pasted URL carried a password — capture it into the field and strip
      // it from what we show, so the secret doesn't linger on screen.
      setFields(parsed);
      setUrl(displayUrl(activeEngine, parsed));
    } else {
      // Keep the password already typed into the field; show the URL as typed.
      setFields({ ...parsed, password: fields.password });
      setUrl(value);
    }
  }

  function applyDetected(candidate: DetectedConnection) {
    setEngine(candidate.engine);
    const parsed =
      candidate.engine === "sqlite" ? null : parseConnectionUrl(candidate.url);
    if (parsed) {
      setFields(parsed);
      setUrl(displayUrl(candidate.engine, parsed));
    } else {
      setUrl(candidate.url);
    }
    resetTest();
    if (!name.trim()) setName(suggestName(candidate));
    // Classify under the project the source service lives in, when we know it.
    const repo = candidate.cwd
      ? projects.find((project) => pathInScope(candidate.cwd, project.path))
      : undefined;
    if (repo) setProjectPath(repo.path);
  }

  function validate(): string | null {
    if (!name.trim()) return "Name is required.";
    if (isSqlite) {
      if (!url.trim()) return "Database file path is required.";
      return null;
    }
    if (!fields.host.trim()) return "Host is required.";
    if (!fields.database.trim()) return "Database name is required.";
    return null;
  }

  async function runTest() {
    if (!canConnect) return;
    setTesting(true);
    resetTest();
    try {
      const result = await testDatabase({ engine, url: submitUrl });
      setTestState(
        result.ok
          ? { status: "ok", message: "Connected" }
          : { status: "fail", message: result.error ?? "Connection failed" },
      );
    } catch (caught) {
      setTestState({
        status: "fail",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    const problem = validate();
    if (problem) {
      showError(problem);
      return;
    }
    setSaving(true);
    try {
      await addDatabase({ name: name.trim(), engine, url: submitUrl, projectPath });
      showSuccess(`Saved connection "${name.trim()}".`);
      onSaved();
      onClose();
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ComposerDialog
      icon={<Database />}
      onClose={onClose}
      title={isEditing ? "Edit database connection" : "Add database connection"}
    >
      <div className="flex flex-col gap-4">
        {detected.length > 0 ? (
          <section>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Wand2 className="size-3.5" />
              Found in your services
            </p>
            <div className="flex flex-wrap gap-1.5">
              {detected.map((candidate) => (
                <button
                  key={`${candidate.service}:${candidate.key}`}
                  type="button"
                  onClick={() => applyDetected(candidate)}
                  className="group flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-left text-xs transition-colors hover:border-primary hover:bg-muted"
                  title={candidate.maskedUrl}
                >
                  <Badge variant="outline" size="small">
                    {candidate.engine}
                  </Badge>
                  <span className="font-mono">{candidate.service}</span>
                  <span className="font-mono text-muted-foreground">·{candidate.key}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Engine</p>
          <div className="flex gap-1.5">
            {ENGINES.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={engine === option.value ? "default" : "outline"}
                onClick={() => changeEngine(option.value)}
                disabled={isEditing}
                type="button"
              >
                {option.label}
              </Button>
            ))}
          </div>
        </section>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. shop-db"
            disabled={isEditing}
          />
          {isEditing ? (
            <span className="text-[11px] text-muted-foreground">
              The name identifies the connection and can't be changed here.
            </span>
          ) : null}
        </label>

        {projects.length > 0 ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Project</span>
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              onChange={(event) => setProjectPath(event.target.value)}
              value={projectPath}
            >
              <option value="">No project (shared)</option>
              {projectPath && !projects.some((project) => project.path === projectPath) ? (
                // Assignment to a repo that's no longer registered — keep it
                // visible so an unrelated edit doesn't silently clear it.
                <option value={projectPath}>{projectPath}</option>
              ) : null}
              {projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.name}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-muted-foreground">
              Classifies the connection under a project; shared connections show
              in every project scope.
            </span>
          </label>
        ) : null}

        {!isSqlite ? (
          <section className="flex flex-col gap-3">
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Host</span>
                <Input
                  value={fields.host}
                  onChange={(event) => changeField({ host: event.target.value })}
                  placeholder="localhost"
                  className="font-mono text-xs"
                />
              </label>
              <label className="flex w-24 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Port</span>
                <Input
                  value={fields.port}
                  onChange={(event) => changeField({ port: event.target.value })}
                  placeholder={engine === "mysql" ? "3306" : "5432"}
                  className="font-mono text-xs"
                />
              </label>
            </div>
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">User</span>
                <Input
                  value={fields.user}
                  onChange={(event) => changeField({ user: event.target.value })}
                  placeholder="postgres"
                  className="font-mono text-xs"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Password</span>
                <Input
                  type="password"
                  value={fields.password}
                  onChange={(event) => changeField({ password: event.target.value })}
                  placeholder={isEditing ? "leave blank to keep current" : "••••••••"}
                  className="font-mono text-xs"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Database</span>
              <Input
                value={fields.database}
                onChange={(event) => changeField({ database: event.target.value })}
                placeholder="app"
                className="font-mono text-xs"
              />
            </label>
            {engine === "postgres" ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={fields.ssl}
                  onChange={(event) => changeField({ ssl: event.target.checked })}
                  className="size-3.5 accent-primary"
                />
                Require SSL (adds <span className="font-mono">?sslmode=require</span>)
              </label>
            ) : null}
          </section>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {isSqlite ? "Database file path" : "Connection URL"}
          </span>
          <Input
            value={url}
            onChange={(event) => changeUrl(event.target.value)}
            placeholder={
              isSqlite
                ? "/abs/path/to/app.db"
                : engine === "mysql"
                  ? "mysql://user:pass@host:3306/db"
                  : "postgres://user:pass@host:5432/db"
            }
            className="font-mono text-xs"
          />
          <span className="text-[11px] text-muted-foreground">
            {isSqlite
              ? "Read-only. Stored like a secret and masked in the UI and API."
              : "Synced with the fields above; the password stays in its field and is never shown here. Stored like a secret and masked in the UI and API."}
          </span>
        </label>

        {testState.status !== "idle" ? (
          <div
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${
              testState.status === "ok"
                ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/40 text-destructive"
            }`}
          >
            {testState.status === "ok" ? (
              <Check className="size-3.5" />
            ) : (
              <X className="size-3.5" />
            )}
            <span className="break-all font-mono">{testState.message}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runTest()}
            disabled={testing || !canConnect}
            type="button"
          >
            {testing ? <Loader2 className="animate-spin" /> : null}
            Test connection
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving} type="button">
            {saving ? <Loader2 className="animate-spin" /> : null}
            {isEditing ? "Save changes" : "Save"}
          </Button>
        </div>
      </div>
    </ComposerDialog>
  );
}

/** Initial form state — empty for a new connection, or unpacked from an edit. */
function seedState(initial?: EditTarget): {
  engine: DatabaseEngine;
  name: string;
  fields: ConnectionFields;
  url: string;
} {
  if (!initial) {
    return { engine: "postgres", name: "", fields: EMPTY_FIELDS, url: "" };
  }
  if (initial.engine === "sqlite") {
    return { engine: "sqlite", name: initial.name, fields: EMPTY_FIELDS, url: initial.url };
  }
  // The stored URL is password-masked, so parse everything else and blank the
  // password — the server keeps the real one when we save it empty.
  const parsed = parseConnectionUrl(initial.url);
  const fields = parsed ? { ...parsed, password: "" } : EMPTY_FIELDS;
  return {
    engine: initial.engine,
    name: initial.name,
    fields,
    url: buildConnectionUrl(initial.engine, fields, { includePassword: false }),
  };
}

function suggestName(candidate: DetectedConnection): string {
  try {
    const parsed = new URL(candidate.url);
    const db = parsed.pathname.replace(/^\//, "");
    if (db) return `${candidate.service}-${db}`;
  } catch {
    // fall through
  }
  return `${candidate.service}-${candidate.engine}`;
}
