import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useState } from "react";
import { Columns3, Copy, KeyRound, Play, Workflow } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { useToasts } from "@/components/ui/toast";
import {
  getDatabaseObjectDetails,
  getDatabaseObjectRows,
  type DatabaseObject,
  type DatabaseObjectDetails,
  type RowBrowseQuery,
  type RowFilter,
  type RowSample,
} from "@/lib/api";
import { AiContextTarget } from "@/features/agent/context-menu/ai-context-menu";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usePersistentState } from "@/lib/use-persistent-state";
import { TableGrid } from "./table-grid";
import { DatabaseRowFilters } from "./database-row-filters";
import { DatabaseExportMenu } from "./database-export-menu";
import { databaseLimitOptions } from "./use-databases";
import { SAMPLEABLE, type ObjectDetailTab } from "./catalog-model";
import "../git/file-viewer-theme.css";

/**
 * The details pane for one selected object: its rows, its structure, and the
 * CREATE script, plus the SQL highlighting they share.
 */

export function ObjectDetailsPanel({
  connection,
  object,
  objectKey,
  onObjectMissing,
  onWriteAccessChange,
  resultLimit,
  writeUnlocked,
}: {
  connection: string;
  object: DatabaseObject;
  objectKey: string;
  onObjectMissing: () => void;
  onWriteAccessChange: () => void;
  resultLimit: number;
  writeUnlocked: boolean;
}) {
  const t = useT();
  const [details, setDetails] = useState<DatabaseObjectDetails | null>(null);
  const [sample, setSample] = useState<RowSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(resultLimit);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<RowFilter[]>([]);
  const [sort, setSort] = useState<RowBrowseQuery["sort"]>();
  const [reloadToken, setReloadToken] = useState(0);
  const [activeTab, setActiveTab] = usePersistentState<ObjectDetailTab>(
    "database:object-tab",
    "data",
  );
  const sampleable = SAMPLEABLE.has(object.kind);

  useEffect(() => {
    setOffset(0);
    setLimit(resultLimit);
    setFilters([]);
    setSort(undefined);
  }, [object.key, resultLimit]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const requests: [Promise<DatabaseObjectDetails>, Promise<RowSample | null>] = [
      getDatabaseObjectDetails(connection, object.key),
      sampleable
        ? getDatabaseObjectRows(connection, object.key, limit, offset, { filters, sort })
        : Promise.resolve(null),
    ];
    Promise.all(requests)
      .then(([nextDetails, nextSample]) => {
        if (cancelled) return;
        setDetails(nextDetails);
        setSample(nextSample);
      })
      .catch((caught) => {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        if (/not found in (?:the )?live catalog/i.test(message)) {
          onObjectMissing();
          return;
        }
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, filters, limit, object.key, offset, reloadToken, sampleable, sort]);

  const canPrev = offset > 0;
  const canNext = sample?.rowCount === limit;

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold" title={object.qualifiedName}>
          {object.qualifiedName}
        </span>
        <Badge size="small" variant="outline">{object.kind}</Badge>
        {sample && activeTab === "data" ? (
          <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="tabular-nums">
              {sample.rowCount ? t("database.rowsRange", { from: offset + 1, to: offset + sample.rowCount }) : t("database.noRows")}
            </span>
            <select
              aria-label={t("database.rowsPerPage")}
              className="h-6 rounded border border-border bg-background px-1 text-[10px]"
              onChange={(event) => { setLimit(Number(event.target.value)); setOffset(0); }}
              value={limit}
            >
              {databaseLimitOptions(resultLimit).map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
            <Button className="h-6 px-1.5" disabled={!canPrev} onClick={() => setOffset(Math.max(0, offset - limit))} size="sm" type="button" variant="ghost">{t("database.prev")}</Button>
            <Button className="h-6 px-1.5" disabled={!canNext} onClick={() => setOffset(offset + limit)} size="sm" type="button" variant="ghost">{t("database.next")}</Button>
          </div>
        ) : null}
      </header>
      {error ? <Alert className="m-3" variant="destructive">{error}</Alert> : loading && !details ? (
        <Loading className="flex-1" label={t("database.catalog.loadingDetails")} />
      ) : details ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            aria-label={t("database.catalog.objectViews")}
            className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5"
            role="tablist"
          >
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              <DetailTab
                active={activeTab === "data"}
                id="data"
                label={sampleable ? t("database.catalog.data") : t("database.catalog.definition")}
                onSelect={setActiveTab}
              />
              <DetailTab
                active={activeTab === "structure"}
                id="structure"
                label={t("database.catalog.structure")}
                onSelect={setActiveTab}
              />
              <DetailTab
                active={activeTab === "script"}
                id="script"
                label={t("database.catalog.createScript")}
                onSelect={setActiveTab}
              />
            </div>
            {sampleable && activeTab === "data" ? (
              <DatabaseExportMenu
                connection={connection}
                objectKey={objectKey}
                qualifiedName={object.qualifiedName}
              />
            ) : null}
          </div>
          <div
            aria-labelledby="database-object-tab-data"
            className={cn(
              "min-h-0 flex-1 overflow-hidden",
              activeTab === "data" ? "flex" : "hidden",
            )}
            hidden={activeTab !== "data"}
            id="database-object-panel-data"
            role="tabpanel"
          >
            {sample ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <DatabaseRowFilters
                  columns={sample.columns}
                  filters={filters}
                  onChange={(next) => { setFilters(next); setOffset(0); }}
                />
                <TableGrid
                  canDelete={object.kind === "table"}
                  connection={connection}
                  objectKey={objectKey}
                  onDeleted={() => setReloadToken((value) => value + 1)}
                  onSortChange={(next) => { setSort(next); setOffset(0); }}
                  onWriteAccessChange={onWriteAccessChange}
                  sample={sample}
                  sort={sort}
                  writeUnlocked={writeUnlocked}
                />
              </div>
            ) : (
              <pre className="min-h-full whitespace-pre-wrap break-words p-3 font-mono text-[11px] text-muted-foreground">{details.definition ?? t("database.catalog.noDefinition")}</pre>
            )}
          </div>
          <div
            aria-labelledby="database-object-tab-structure"
            className={cn(
              "min-h-0 flex-1 overflow-auto",
              activeTab !== "structure" && "hidden",
            )}
            hidden={activeTab !== "structure"}
            id="database-object-panel-structure"
            role="tabpanel"
          >
            <DetailSections details={details} />
          </div>
          <div
            aria-labelledby="database-object-tab-script"
            className={cn(
              "min-h-0 flex-1 overflow-auto",
              activeTab !== "script" && "hidden",
            )}
            hidden={activeTab !== "script"}
            id="database-object-panel-script"
            role="tabpanel"
          >
            <CreateScriptPanel script={details.createScript} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DetailTab({
  active,
  id,
  label,
  onSelect,
}: {
  active: boolean;
  id: ObjectDetailTab;
  label: string;
  onSelect: (id: ObjectDetailTab) => void;
}) {
  return (
    <button
      aria-controls={`database-object-panel-${id}`}
      aria-selected={active}
      className={cn(
        "shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground",
      )}
      id={`database-object-tab-${id}`}
      onClick={() => onSelect(id)}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}

function CreateScriptPanel({ script }: { script?: string }) {
  const t = useT();
  const { error: showError, success: showSuccess } = useToasts();

  async function copyScript() {
    if (!script) return;
    try {
      await navigator.clipboard.writeText(script);
      showSuccess(t("common.copied"));
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  if (!script) {
    return (
      <div className="p-6 text-xs text-muted-foreground">
        {t("database.catalog.noCreateScript")}
      </div>
    );
  }

  return (
    <div className="relative min-h-full bg-muted/10">
      <Button
        aria-label={t("database.catalog.copyCreateScript")}
        className="sticky right-2 top-2 z-10 float-right h-7 gap-1.5 px-2 text-[10px]"
        onClick={() => void copyScript()}
        size="sm"
        type="button"
        variant="outline"
      >
        <Copy aria-hidden="true" className="size-3" />
        {t("common.copy")}
      </Button>
      <pre className="min-h-full whitespace-pre p-3 pr-20 font-mono text-[11px] leading-relaxed">
        <HighlightedSql value={script} />
      </pre>
    </div>
  );
}

function DetailSections({ details }: { details: DatabaseObjectDetails }) {
  const t = useT();
  return (
    <div className="grid gap-px bg-border sm:grid-cols-2">
      <DetailGroup icon={<Columns3 />} title={t("database.catalog.columns")}>
        {details.columns.map((column) => (
          <DetailRow key={column.name} label={column.name} value={`${column.dataType}${column.nullable ? "" : " NOT NULL"}${column.primaryKey ? " PRIMARY KEY" : ""}`} />
        ))}
      </DetailGroup>
      <DetailGroup icon={<KeyRound />} title={t("database.catalog.indexes")}>
        {details.indexes.map((index) => <DetailRow key={index.name} label={index.name} value={index.definition} />)}
      </DetailGroup>
      <DetailGroup icon={<Workflow />} title={t("database.catalog.constraints")}>
        {details.constraints.map((constraint) => <DetailRow key={constraint.name} label={constraint.name} value={constraint.definition || constraint.type} />)}
      </DetailGroup>
      <DetailGroup icon={<Play />} title={t("database.catalog.triggers")}>
        {details.triggers.map((trigger) => <DetailRow key={trigger.name} label={trigger.name} value={trigger.definition} />)}
      </DetailGroup>
    </div>
  );
}

function DetailGroup({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 bg-background p-2.5">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
        <span className="[&_svg]:size-3" aria-hidden="true">{icon}</span>{title}
      </h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const t = useT();
  const { error: showError, success: showSuccess } = useToasts();

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(t("common.copied"));
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <AiContextTarget
      target={{
        actions: [
          {
            icon: <Copy aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
            id: "copy-name",
            label: t("database.catalog.copyName"),
            onSelect: () => void copy(label),
          },
          {
            icon: <Copy aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
            id: "copy-definition",
            label: t("database.catalog.copyDefinition"),
            onSelect: () => void copy(value),
          },
        ],
        intents: [],
        label,
      }}
    >
      <div className="grid min-w-0 grid-cols-[minmax(4rem,0.35fr)_minmax(0,1fr)] gap-2 font-mono text-[10px]">
        <span className="truncate" title={label}>{label}</span>
        <span className="min-w-0 truncate" title={value}>
          <HighlightedSql className="block truncate" value={value} />
        </span>
      </div>
    </AiContextTarget>
  );
}

function HighlightedSql({
  className,
  value,
}: {
  className?: string;
  value: string;
}) {
  const highlighted = useMemo(
    () => hljs.highlight(value, { language: "sql", ignoreIllegals: true }).value,
    [value],
  );
  return (
    <code
      className={cn("hljs", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes SQL before adding spans.
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}
