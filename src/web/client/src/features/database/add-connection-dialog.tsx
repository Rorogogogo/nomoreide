import { useEffect, useState } from "react";
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
} from "@/lib/api";

const ENGINES: { value: DatabaseEngine; label: string }[] = [
  { value: "postgres", label: "Postgres" },
  { value: "mysql", label: "MySQL" },
  { value: "sqlite", label: "SQLite" },
];

type TestState = { status: "idle" | "ok" | "fail"; message?: string };

export function AddConnectionDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { error: showError, success: showSuccess } = useToasts();
  const [engine, setEngine] = useState<DatabaseEngine>("postgres");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [detected, setDetected] = useState<DetectedConnection[]>([]);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    detectDatabases()
      .then(setDetected)
      .catch(() => setDetected([]));
  }, []);

  function applyDetected(candidate: DetectedConnection) {
    setEngine(candidate.engine);
    setUrl(candidate.url);
    setTestState({ status: "idle" });
    if (!name.trim()) {
      setName(suggestName(candidate));
    }
  }

  async function runTest() {
    if (!url.trim()) return;
    setTesting(true);
    setTestState({ status: "idle" });
    try {
      const result = await testDatabase({ engine, url: url.trim() });
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
    if (!name.trim() || !url.trim()) {
      showError("Name and connection are both required.");
      return;
    }
    setSaving(true);
    try {
      await addDatabase({ name: name.trim(), engine, url: url.trim() });
      showSuccess(`Saved connection "${name.trim()}".`);
      onSaved();
      onClose();
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  const isSqlite = engine === "sqlite";

  return (
    <ComposerDialog icon={<Database />} onClose={onClose} title="Add database connection">
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
                onClick={() => {
                  setEngine(option.value);
                  setTestState({ status: "idle" });
                }}
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
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {isSqlite ? "Database file path" : "Connection URL"}
          </span>
          <Input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setTestState({ status: "idle" });
            }}
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
            Read-only. The connection string is stored like a secret and masked in the UI and API.
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
            disabled={testing || !url.trim()}
            type="button"
          >
            {testing ? <Loader2 className="animate-spin" /> : null}
            Test connection
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving} type="button">
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </ComposerDialog>
  );
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
