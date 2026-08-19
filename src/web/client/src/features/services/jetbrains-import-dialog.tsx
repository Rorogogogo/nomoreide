import { FileInput, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToasts } from "@/components/ui/toast";
import {
  applyJetBrainsImport,
  scanJetBrainsProject,
  type JetBrainsImportPreview,
  type JetBrainsImportSelection,
  type JetBrainsRunCandidate,
  type JetBrainsDatabaseCandidate,
  type JetBrainsDatabaseSelection,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ArgumentsEditor } from "./service-form/invocation-editors";
import { ComposerDialog } from "./service-form/composer-dialog";

interface CandidateState extends JetBrainsRunCandidate {
  selected: boolean;
  resolution: JetBrainsImportSelection["conflict"];
  importedName: string;
}

interface DatabaseState extends JetBrainsDatabaseCandidate {
  selected: boolean;
  resolution: JetBrainsDatabaseSelection["conflict"];
  importedName: string;
  importedUsername: string;
  password: string;
  test: boolean;
}

export function JetBrainsImportDialog({
  initialRoot,
  onClose,
  onRefresh,
}: {
  initialRoot: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  const toasts = useToasts();
  const [projectRoot, setProjectRoot] = useState(initialRoot);
  const [includePersonal, setIncludePersonal] = useState(false);
  const [preview, setPreview] = useState<JetBrainsImportPreview | null>(null);
  const [candidates, setCandidates] = useState<CandidateState[]>([]);
  const [databases, setDatabases] = useState<DatabaseState[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      const next = await scanJetBrainsProject(projectRoot.trim(), includePersonal);
      setPreview(next);
      setCandidates(next.candidates.map((candidate) => ({
        ...candidate,
        selected: !candidate.conflict,
        resolution: candidate.conflict ? "skip" : "add",
        importedName: candidate.name,
      })));
      setDatabases(next.databases.map((database) => ({
        ...database,
        selected: !database.conflict,
        resolution: database.conflict ? "skip" : "add",
        importedName: database.name,
        importedUsername: database.username ?? "",
        password: "",
        test: false,
      })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    const missingCredentials = databases.find(
      (database) =>
        database.selected &&
        database.resolution !== "skip" &&
        database.engine !== "sqlite" &&
        (!database.importedUsername.trim() || !database.password),
    );
    if (missingCredentials) {
      setError(t("services.jetbrains.credentialsRequired", { name: missingCredentials.name }));
      return;
    }
    const selections = candidates
      .filter((candidate) => candidate.selected)
      .map((candidate): JetBrainsImportSelection => ({
        id: candidate.id,
        conflict: candidate.selected ? candidate.resolution : "skip",
        ...(candidate.resolution === "rename" ? { name: candidate.importedName } : {}),
        command: candidate.command,
        ...(candidate.args === undefined ? {} : { args: candidate.args }),
        cwd: candidate.cwd,
      }));
    setBusy(true);
    setError(null);
    try {
      const databaseSelections = databases
        .filter((database) => database.selected)
        .map((database): JetBrainsDatabaseSelection => ({
          id: database.id,
          conflict: database.resolution,
          ...(database.resolution === "rename" ? { name: database.importedName } : {}),
          ...(database.engine === "sqlite"
            ? {}
            : { username: database.importedUsername, password: database.password }),
          test: database.test,
        }));
      const imported = await applyJetBrainsImport(
        preview.sessionId,
        selections,
        databaseSelections,
      );
      await onRefresh();
      toasts.success(t("services.jetbrains.imported", {
        services: imported.services.length,
        databases: imported.databases.length,
      }));
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function update(id: string, patch: Partial<CandidateState>) {
    setCandidates((current) =>
      current.map((candidate) => candidate.id === id ? { ...candidate, ...patch } : candidate),
    );
  }

  function updateDatabase(id: string, patch: Partial<DatabaseState>) {
    setDatabases((current) =>
      current.map((database) => database.id === id ? { ...database, ...patch } : database),
    );
  }

  const selectedCount = candidates.filter(
    (candidate) => candidate.selected && candidate.resolution !== "skip",
  ).length;
  const selectedDatabaseCount = databases.filter(
    (database) => database.selected && database.resolution !== "skip",
  ).length;

  return (
    <ComposerDialog
      icon={<FileInput aria-hidden />}
      onClose={onClose}
      size="lg"
      title={t("services.jetbrains.title")}
    >
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">{t("services.jetbrains.intro")}</p>
        <div className="grid gap-2 border-y border-border py-3">
          <label className="grid gap-1 text-[11px] font-medium" htmlFor="jetbrains-project-root">
            {t("services.jetbrains.projectRoot")}
            <Input
              className="h-8 font-mono text-xs"
              id="jetbrains-project-root"
              onChange={(event) => setProjectRoot(event.target.value)}
              value={projectRoot}
            />
          </label>
          <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
            <input
              checked={includePersonal}
              className="mt-0.5"
              onChange={(event) => setIncludePersonal(event.target.checked)}
              type="checkbox"
            />
            <span>
              <span className="block font-medium text-foreground">
                {t("services.jetbrains.includePersonal")}
              </span>
              {t("services.jetbrains.includePersonalHint")}
            </span>
          </label>
          <div className="flex justify-end">
            <Button disabled={busy || !projectRoot.trim()} onClick={scan} size="sm" type="button">
              {busy && !preview ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {t("services.jetbrains.scan")}
            </Button>
          </div>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {preview ? (
          <>
            <div className="text-[10px] text-muted-foreground">
              {t("services.jetbrains.scanSummary", {
                supported: candidates.length,
                unsupported: preview.unsupported.length,
                databases: databases.length,
              })}
            </div>
            {databases.length > 0 ? (
              <div className="grid gap-1.5">
                <div className="text-[11px] font-medium">
                  {t("services.jetbrains.databases")}
                </div>
                <div className="divide-y divide-border overflow-auto border-y border-border">
                  {databases.map((database) => (
                    <DatabaseEditor
                      database={database}
                      key={database.id}
                      onChange={updateDatabase}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            <div className="max-h-[52vh] divide-y divide-border overflow-auto border-y border-border">
              {candidates.map((candidate) => (
                <CandidateEditor candidate={candidate} key={candidate.id} onChange={update} />
              ))}
              {candidates.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {t("services.jetbrains.noneSupported")}
                </p>
              ) : null}
            </div>
            {preview.unsupported.length > 0 ? (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">
                  {t("services.jetbrains.unsupported", { count: preview.unsupported.length })}
                </summary>
                <div className="mt-1 divide-y divide-border/70 border-y border-border/70">
                  {preview.unsupported.map((item) => (
                    <div className="px-2 py-1.5" key={`${item.source}:${item.name}`}>
                      <div className="font-medium">{item.name}</div>
                      <div className="text-muted-foreground">{item.runType} · {item.reason}</div>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
            {preview.unsupportedDatabases.length > 0 ? (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">
                  {t("services.jetbrains.unsupportedDatabases", {
                    count: preview.unsupportedDatabases.length,
                  })}
                </summary>
                <div className="mt-1 divide-y divide-border/70 border-y border-border/70">
                  {preview.unsupportedDatabases.map((item) => (
                    <div className="px-2 py-1.5" key={`${item.source}:${item.name}`}>
                      <div className="font-medium">{item.name}</div>
                      <div className="text-muted-foreground">{item.reason}</div>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                {t("services.jetbrains.noAutoStart")}
              </span>
              <Button
                disabled={busy || selectedCount + selectedDatabaseCount === 0}
                onClick={apply}
                type="button"
              >
                {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
                {t("services.jetbrains.importSelected", {
                  count: selectedCount + selectedDatabaseCount,
                })}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </ComposerDialog>
  );
}

function CandidateEditor({
  candidate,
  onChange,
}: {
  candidate: CandidateState;
  onChange: (id: string, patch: Partial<CandidateState>) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-2 px-2 py-2.5 hover:bg-muted/20">
      <div className="flex items-start gap-2">
        <input
          aria-label={t("services.jetbrains.select", { name: candidate.name })}
          checked={candidate.selected}
          className="mt-1"
          onChange={(event) => onChange(candidate.id, {
            selected: event.target.checked,
            ...(event.target.checked && candidate.conflict && candidate.resolution === "skip"
              ? { resolution: "replace" }
              : {}),
          })}
          type="checkbox"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium">{candidate.name}</span>
            <span className="font-mono text-[9px] text-muted-foreground">{candidate.runType}</span>
          </div>
          <div className="truncate font-mono text-[9px] text-muted-foreground" title={candidate.source}>
            {candidate.source}
          </div>
        </div>
      </div>
      {candidate.selected ? (
        <div className="ml-5 grid gap-2">
          {candidate.conflict ? (
            <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-2">
              <select
                aria-label={t("services.jetbrains.conflictFor", { name: candidate.name })}
                className="h-8 rounded-md border border-border bg-background px-2 text-[11px]"
                onChange={(event) => onChange(candidate.id, {
                  resolution: event.target.value as CandidateState["resolution"],
                })}
                value={candidate.resolution}
              >
                <option value="skip">{t("services.jetbrains.skip")}</option>
                <option value="replace">{t("services.jetbrains.replace")}</option>
                <option value="rename">{t("services.jetbrains.rename")}</option>
              </select>
              {candidate.resolution === "rename" ? (
                <Input
                  aria-label={t("services.jetbrains.newName")}
                  className="h-8 text-xs"
                  onChange={(event) => onChange(candidate.id, { importedName: event.target.value })}
                  value={candidate.importedName}
                />
              ) : null}
            </div>
          ) : null}
          <Input
            aria-label={t("services.jetbrains.commandFor", { name: candidate.name })}
            className="h-8 font-mono text-xs"
            onChange={(event) => onChange(candidate.id, { command: event.target.value })}
            value={candidate.command}
          />
          {candidate.args !== undefined ? (
            <ArgumentsEditor
              args={candidate.args}
              onChange={(args) => onChange(candidate.id, { args })}
            />
          ) : null}
          <Input
            aria-label={t("services.jetbrains.cwdFor", { name: candidate.name })}
            className="h-8 font-mono text-xs"
            onChange={(event) => onChange(candidate.id, { cwd: event.target.value })}
            value={candidate.cwd}
          />
          {candidate.envKeys.length > 0 ? (
            <div className="font-mono text-[9px] text-muted-foreground">
              {t("services.jetbrains.envKeys")}: {candidate.envKeys.join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DatabaseEditor({
  database,
  onChange,
}: {
  database: DatabaseState;
  onChange: (id: string, patch: Partial<DatabaseState>) => void;
}) {
  const t = useT();
  const location = database.engine === "sqlite"
    ? database.path
    : `${database.host ?? "localhost"}${database.port ? `:${database.port}` : ""}/${database.database ?? ""}`;
  return (
    <div className="grid gap-2 px-2 py-2.5 hover:bg-muted/20">
      <div className="flex items-start gap-2">
        <input
          aria-label={t("services.jetbrains.selectDatabase", { name: database.name })}
          checked={database.selected}
          className="mt-1"
          onChange={(event) => onChange(database.id, {
            selected: event.target.checked,
            ...(event.target.checked && database.conflict && database.resolution === "skip"
              ? { resolution: "replace" }
              : {}),
          })}
          type="checkbox"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="text-xs font-medium">{database.name}</span>
            <span className="font-mono text-[9px] text-muted-foreground">{database.engine}</span>
          </div>
          <div className="truncate font-mono text-[9px] text-muted-foreground" title={location}>
            {location}
          </div>
        </div>
      </div>
      {database.selected ? (
        <div className="ml-5 grid gap-2">
          {database.conflict ? (
            <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-2">
              <select
                aria-label={t("services.jetbrains.databaseConflictFor", { name: database.name })}
                className="h-8 rounded-md border border-border bg-background px-2 text-[11px]"
                onChange={(event) => onChange(database.id, {
                  resolution: event.target.value as DatabaseState["resolution"],
                })}
                value={database.resolution}
              >
                <option value="skip">{t("services.jetbrains.skip")}</option>
                <option value="replace">{t("services.jetbrains.replace")}</option>
                <option value="rename">{t("services.jetbrains.rename")}</option>
              </select>
              {database.resolution === "rename" ? (
                <Input
                  aria-label={t("services.jetbrains.newDatabaseName")}
                  className="h-8 text-xs"
                  onChange={(event) => onChange(database.id, { importedName: event.target.value })}
                  value={database.importedName}
                />
              ) : null}
            </div>
          ) : null}
          {database.engine !== "sqlite" ? (
            <div className="grid grid-cols-2 gap-2">
              <Input
                aria-label={t("services.jetbrains.databaseUsername", { name: database.name })}
                className="h-8 font-mono text-xs"
                onChange={(event) => onChange(database.id, { importedUsername: event.target.value })}
                placeholder={t("services.jetbrains.username")}
                required
                value={database.importedUsername}
              />
              <Input
                aria-label={t("services.jetbrains.databasePassword", { name: database.name })}
                autoComplete="new-password"
                className="h-8 font-mono text-xs"
                onChange={(event) => onChange(database.id, { password: event.target.value })}
                placeholder={t("services.jetbrains.password")}
                required
                type="password"
                value={database.password}
              />
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <input
              checked={database.test}
              onChange={(event) => onChange(database.id, { test: event.target.checked })}
              type="checkbox"
            />
            {t("services.jetbrains.testBeforeImport")}
          </label>
          <div className="text-[9px] text-muted-foreground">
            {t("services.jetbrains.writeLocked")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
