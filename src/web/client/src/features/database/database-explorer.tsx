import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns3,
  Copy,
  ExternalLink,
  Eye,
  FunctionSquare,
  KeyRound,
  ListTree,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Table2,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  siMysql,
  siPostgresql,
  siSqlite,
  type SimpleIcon,
} from "simple-icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { Tooltip } from "@/components/ui/tooltip";
import { useToasts } from "@/components/ui/toast";
import { AiContextTarget } from "@/features/agent/context-menu/ai-context-menu";
import {
  getDatabaseCapabilities,
  getDatabaseObjectDetails,
  getDatabaseObjectRows,
  getDatabaseObjects,
  getDatabaseSchemas,
  type DatabaseCapabilities,
  type DatabaseConnection,
  type DatabaseObject,
  type DatabaseObjectDetails,
  type DatabaseObjectKind,
  type DatabaseSchema,
  type RowBrowseQuery,
  type RowFilter,
  type RowSample,
} from "@/lib/api";
import { useT, type TranslationKey } from "@/lib/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";
import { TableGrid } from "./table-grid";
import { DatabaseRowFilters } from "./database-row-filters";
import { DatabaseExportMenu } from "./database-export-menu";
import { DbAddMenu } from "./db-add-menu";
import { databaseLimitOptions } from "./use-databases";
import "../git/file-viewer-theme.css";

interface ConnectionCatalog {
  capabilities: DatabaseCapabilities;
  schemas: DatabaseSchema[];
}

interface LoadState<T> {
  value?: T;
  loading?: boolean;
  error?: string;
}

const CATEGORY_ORDER: Array<{
  kind: DatabaseObjectKind;
  label: TranslationKey;
}> = [
  { kind: "table", label: "database.catalog.tables" },
  { kind: "view", label: "database.catalog.views" },
  { kind: "materializedView", label: "database.catalog.materializedViews" },
  { kind: "function", label: "database.catalog.functions" },
  { kind: "procedure", label: "database.catalog.procedures" },
  { kind: "sequence", label: "database.catalog.sequences" },
];

const SAMPLEABLE = new Set<DatabaseObjectKind>(["table", "view", "materializedView"]);
const NOOP = () => {};
type ObjectDetailTab = "data" | "structure" | "script";
export type SelectedCatalogObject = {
  connection: string;
  object: DatabaseObject;
};

type ExplorerSurface = "browse" | "sql";

export function DatabaseExplorer({
  connections,
  selectedConnection,
  selectedCatalogObject,
  sidebarOnly = false,
  surface = "browse",
  onAddConnection,
  onAddWithAi,
  onEditConnection,
  onRemoveConnection,
  onSelectConnection,
  onSelectedCatalogObjectChange,
  onOpenObjectInBrowse,
  onInsertObjectName,
  onGenerateObjectSelect,
  onWriteAccessChange = NOOP,
  resultLimit,
}: {
  connections: DatabaseConnection[];
  selectedConnection: string | null;
  selectedCatalogObject?: SelectedCatalogObject | null;
  /** Render only the catalog tree, for companion surfaces such as the SQL console. */
  sidebarOnly?: boolean;
  surface?: ExplorerSurface;
  onAddConnection: () => void;
  onAddWithAi: () => void;
  onEditConnection: (connection: DatabaseConnection) => void;
  onRemoveConnection: (name: string) => void;
  onSelectConnection: (name: string) => void;
  onSelectedCatalogObjectChange?: (selection: SelectedCatalogObject | null) => void;
  onOpenObjectInBrowse?: (selection: SelectedCatalogObject) => void;
  onInsertObjectName?: (selection: SelectedCatalogObject) => void;
  onGenerateObjectSelect?: (selection: SelectedCatalogObject) => void;
  onWriteAccessChange?: () => void;
  resultLimit: number;
}) {
  const t = useT();
  const [expandedConnections, setExpandedConnections] = usePersistentState<string[]>(
    "database:expanded-connections",
    [],
  );
  const [expandedSchemas, setExpandedSchemas] = usePersistentState<string[]>(
    "database:expanded-schemas",
    [],
  );
  const [expandedCategories, setExpandedCategories] = usePersistentState<string[]>(
    "database:expanded-categories",
    [],
  );
  const [catalogs, setCatalogs] = useState<Record<string, LoadState<ConnectionCatalog>>>({});
  const [objects, setObjects] = useState<Record<string, LoadState<DatabaseObject[]>>>({});
  const [storedSelectedObject, setStoredSelectedObject] =
    usePersistentState<SelectedCatalogObject | null>("database:selected-object", null);
  const selectedObject = selectedCatalogObject === undefined
    ? storedSelectedObject
    : selectedCatalogObject;

  function setSelectedObject(selection: SelectedCatalogObject | null) {
    if (selectedCatalogObject === undefined) setStoredSelectedObject(selection);
    onSelectedCatalogObjectChange?.(selection);
  }

  async function loadConnection(connection: string, force = false) {
    if (!force && (catalogs[connection]?.loading || catalogs[connection]?.value)) return;
    setCatalogs((current) => ({ ...current, [connection]: { loading: true } }));
    try {
      const [capabilities, schemas] = await Promise.all([
        getDatabaseCapabilities(connection),
        getDatabaseSchemas(connection),
      ]);
      setCatalogs((current) => ({
        ...current,
        [connection]: { value: { capabilities, schemas } },
      }));
    } catch (caught) {
      setCatalogs((current) => ({
        ...current,
        [connection]: {
          error: caught instanceof Error ? caught.message : String(caught),
        },
      }));
    }
  }

  async function loadSchema(connection: string, schema: string, force = false) {
    const key = schemaKey(connection, schema);
    if (!force && (objects[key]?.loading || objects[key]?.value)) return;
    setObjects((current) => ({ ...current, [key]: { loading: true } }));
    try {
      const value = await getDatabaseObjects(connection, schema);
      setObjects((current) => ({ ...current, [key]: { value } }));
      if (
        selectedObject?.connection === connection &&
        selectedObject.object.schema === schema &&
        !value.some((object) => object.key === selectedObject.object.key)
      ) {
        setSelectedObject(null);
      }
    } catch (caught) {
      setObjects((current) => ({
        ...current,
        [key]: { error: caught instanceof Error ? caught.message : String(caught) },
      }));
    }
  }

  useEffect(() => {
    if (!selectedConnection) return;
    setExpandedConnections((current) => addToList(current, selectedConnection));
    void loadConnection(selectedConnection);
  }, [selectedConnection]);

  useEffect(() => {
    const connectionNames = new Set(connections.map((connection) => connection.name));
    const nextConnections = pruneList(
      expandedConnections,
      (name) => connectionNames.has(name),
    );
    const nextSchemas = pruneList(
      expandedSchemas,
      (key) => hasConnectionPrefix(key, connectionNames),
    );
    const nextCategories = pruneList(
      expandedCategories,
      (key) => hasConnectionPrefix(key, connectionNames),
    );
    if (nextConnections !== expandedConnections) {
      setExpandedConnections((current) =>
        pruneList(current, (name) => connectionNames.has(name)),
      );
    }
    if (nextSchemas !== expandedSchemas) {
      setExpandedSchemas((current) =>
        pruneList(current, (key) => hasConnectionPrefix(key, connectionNames)),
      );
    }
    if (nextCategories !== expandedCategories) {
      setExpandedCategories((current) =>
        pruneList(current, (key) => hasConnectionPrefix(key, connectionNames)),
      );
    }
    if (selectedObject && !connectionNames.has(selectedObject.connection)) {
      setSelectedObject(null);
    }
  }, [connections]);

  useEffect(() => {
    for (const [connection, state] of Object.entries(catalogs)) {
      for (const schema of state.value?.schemas ?? []) {
        const key = schemaKey(connection, schema.name);
        if (expandedSchemas.includes(key) && !objects[key]?.loading && !objects[key]?.value) {
          void loadSchema(connection, schema.name);
        }
      }
    }
  }, [catalogs, expandedSchemas]);

  function toggleConnection(name: string) {
    onSelectConnection(name);
    const opening = !expandedConnections.includes(name);
    setExpandedConnections((current) => toggleList(current, name));
    if (opening) void loadConnection(name);
  }

  function toggleSchema(connection: string, schema: string) {
    const key = schemaKey(connection, schema);
    const opening = !expandedSchemas.includes(key);
    setExpandedSchemas((current) => toggleList(current, key));
    if (opening) void loadSchema(connection, schema);
  }

  function selectObject(connection: string, object: DatabaseObject) {
    onSelectConnection(connection);
    setSelectedObject({ connection, object });
  }

  const sidebar = (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-background"
      data-testid="database-explorer-sidebar"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <ListTree aria-hidden="true" className="size-3.5" />
            {t("database.catalog.explorer")}
          </span>
          <div className="flex items-center gap-1">
            <Badge size="small" variant="outline">{connections.length}</Badge>
            <DbAddMenu
              compact
              onAddManual={onAddConnection}
              onAddWithAi={onAddWithAi}
            />
          </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
          {connections.map((connection) => {
            const open = expandedConnections.includes(connection.name);
            const state = catalogs[connection.name];
            return (
              <div key={connection.name}>
                <AiContextTarget
                  target={{
                    actions: [
                      {
                        icon: <Pencil aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
                        id: "edit",
                        label: t("common.edit"),
                        onSelect: () => onEditConnection(connection),
                      },
                      {
                        destructive: true,
                        icon: <Trash2 aria-hidden="true" className="mr-2 size-4" />,
                        id: "delete",
                        label: t("common.delete"),
                        onSelect: () => onRemoveConnection(connection.name),
                      },
                    ],
                    intents: [{
                      id: "ask-connection",
                      label: t("database.askAiAbout", { name: connection.name }),
                      resolvePrompt: () =>
                        `Help me inspect the ${connection.engine} database connection \`${connection.name}\` using NoMoreIDE's read-only database tools. Start by summarizing its schemas and notable objects.`,
                      source: {
                        type: "database-connection",
                        label: connection.name,
                      },
                    }],
                    label: connection.name,
                  }}
                >
                    <div>
                      <TreeButton
                        active={selectedConnection === connection.name}
                        depth={0}
                        description={connection.engine}
                        expanded={open}
                        icon={<DatabaseEngineIcon engine={connection.engine} />}
                        label={connection.name}
                        onClick={() => toggleConnection(connection.name)}
                      />
                    </div>
                </AiContextTarget>
                {open ? (
                  state?.loading ? <LoadingRow depth={1} /> : state?.error ? (
                    <ErrorRow
                      depth={1}
                      error={state.error}
                      onRetry={() => void loadConnection(connection.name, true)}
                    />
                  ) : (
                    (state?.value?.schemas ?? []).map((schema) => (
                      <SchemaBranch
                        capabilities={state.value?.capabilities}
                        connection={connection.name}
                        expandedCategories={expandedCategories}
                        expandedSchemas={expandedSchemas}
                        key={schema.name}
                        objectState={objects[schemaKey(connection.name, schema.name)]}
                        onCategoryToggle={(key) =>
                          setExpandedCategories((current) => toggleList(current, key))
                        }
                        onObjectSelect={selectObject}
                        onGenerateObjectSelect={onGenerateObjectSelect}
                        onInsertObjectName={onInsertObjectName}
                        onOpenObjectInBrowse={onOpenObjectInBrowse}
                        onRetry={() => void loadSchema(connection.name, schema.name, true)}
                        onSchemaToggle={toggleSchema}
                        schema={schema}
                        selectedKey={selectedObject?.object.key ?? null}
                        surface={surface}
                      />
                    ))
                  )
                ) : null}
              </div>
            );
          })}
      </div>
    </aside>
  );

  if (sidebarOnly) return sidebar;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] overflow-hidden max-sm:grid-cols-[minmax(9rem,44vw)_minmax(0,1fr)]">
      {sidebar}

      {selectedObject ? (
        <ObjectDetailsPanel
          connection={selectedObject.connection}
          objectKey={selectedObject.object.key}
          object={selectedObject.object}
          onObjectMissing={() => setSelectedObject(null)}
          onWriteAccessChange={onWriteAccessChange}
          resultLimit={resultLimit}
          writeUnlocked={connections.find((item) => item.name === selectedObject.connection)?.writeUnlocked ?? false}
        />
      ) : (
        <div className="flex min-w-0 items-center justify-center bg-background p-6 text-center text-xs text-muted-foreground">
          {t("database.catalog.pickObject")}
        </div>
      )}
    </div>
  );
}

function SchemaBranch({
  capabilities,
  connection,
  expandedCategories,
  expandedSchemas,
  objectState,
  onCategoryToggle,
  onGenerateObjectSelect,
  onInsertObjectName,
  onObjectSelect,
  onOpenObjectInBrowse,
  onRetry,
  onSchemaToggle,
  schema,
  selectedKey,
  surface,
}: {
  capabilities?: DatabaseCapabilities;
  connection: string;
  expandedCategories: string[];
  expandedSchemas: string[];
  objectState?: LoadState<DatabaseObject[]>;
  onCategoryToggle: (key: string) => void;
  onGenerateObjectSelect?: (selection: SelectedCatalogObject) => void;
  onInsertObjectName?: (selection: SelectedCatalogObject) => void;
  onObjectSelect: (connection: string, object: DatabaseObject) => void;
  onOpenObjectInBrowse?: (selection: SelectedCatalogObject) => void;
  onRetry: () => void;
  onSchemaToggle: (connection: string, schema: string) => void;
  schema: DatabaseSchema;
  selectedKey: string | null;
  surface: ExplorerSurface;
}) {
  const t = useT();
  const key = schemaKey(connection, schema.name);
  const open = expandedSchemas.includes(key);
  const supported = new Set(capabilities?.objectKinds ?? []);
  const byKind = useMemo(() => {
    const map = new Map<DatabaseObjectKind, DatabaseObject[]>();
    for (const object of objectState?.value ?? []) {
      const list = map.get(object.kind) ?? [];
      list.push(object);
      map.set(object.kind, list);
    }
    return map;
  }, [objectState?.value]);

  return (
    <div>
      <TreeButton
        depth={1}
        expanded={open}
        icon={<Braces aria-hidden="true" className="size-3.5" />}
        label={schema.name}
        onClick={() => onSchemaToggle(connection, schema.name)}
      />
      {open ? (
        objectState?.loading ? <LoadingRow depth={2} /> : objectState?.error ? (
          <ErrorRow depth={2} error={objectState.error} onRetry={onRetry} />
        ) : (
          CATEGORY_ORDER.filter((category) => supported.has(category.kind)).map((category) => {
            const categoryKey = `${key}::${category.kind}`;
            const categoryOpen = expandedCategories.includes(categoryKey);
            const entries = byKind.get(category.kind) ?? [];
            return (
              <div key={category.kind}>
                <TreeButton
                  depth={2}
                  expanded={categoryOpen}
                  icon={categoryIcon(category.kind)}
                  label={t(category.label)}
                  meta={String(entries.length)}
                  onClick={() => onCategoryToggle(categoryKey)}
                />
                {categoryOpen
                  ? entries.map((object) => (
                      <CatalogObjectRow
                        active={selectedKey === object.key}
                        connection={connection}
                        depth={3}
                        key={object.key}
                        object={object}
                        onGenerateSelect={onGenerateObjectSelect}
                        onInsertName={onInsertObjectName}
                        onOpenInBrowse={onOpenObjectInBrowse}
                        onSelect={onObjectSelect}
                        surface={surface}
                      />
                    ))
                  : null}
              </div>
            );
          })
        )
      ) : null}
    </div>
  );
}

function CatalogObjectRow({
  active,
  connection,
  depth,
  object,
  onGenerateSelect,
  onInsertName,
  onOpenInBrowse,
  onSelect,
  surface,
}: {
  active: boolean;
  connection: string;
  depth: number;
  object: DatabaseObject;
  onGenerateSelect?: (selection: SelectedCatalogObject) => void;
  onInsertName?: (selection: SelectedCatalogObject) => void;
  onOpenInBrowse?: (selection: SelectedCatalogObject) => void;
  onSelect: (connection: string, object: DatabaseObject) => void;
  surface: ExplorerSurface;
}) {
  const t = useT();
  const selection = { connection, object };
  const actions = surface === "sql" ? [
    {
      icon: <ExternalLink aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
      id: "open-in-browse",
      label: t("database.catalog.openInBrowse"),
      onSelect: () => onOpenInBrowse?.(selection),
    },
    {
      icon: <Code2 aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
      id: "insert-object-name",
      label: t("database.catalog.insertQualifiedName"),
      onSelect: () => onInsertName?.(selection),
    },
    {
      icon: <Play aria-hidden="true" className="mr-2 size-4 text-muted-foreground" />,
      id: "generate-select",
      label: t("database.catalog.generateSelect"),
      onSelect: () => onGenerateSelect?.(selection),
    },
  ] : undefined;

  return (
    <AiContextTarget
      target={{
        actions,
        intents: [
          {
            id: "explain-object",
            label: t("database.catalog.explainWithAi"),
            resolvePrompt: () => buildObjectPrompt(connection, object, "explain"),
            source: { type: "database-object", label: object.qualifiedName },
          },
          {
            id: "query-object",
            label: t("database.catalog.queryWithAi"),
            resolvePrompt: () => buildObjectPrompt(connection, object, "query"),
            source: { type: "database-object", label: object.qualifiedName },
          },
          {
            id: "relationships-object",
            label: t("database.catalog.relationshipsWithAi"),
            resolvePrompt: () => buildObjectPrompt(connection, object, "relationships"),
            source: { type: "database-object", label: object.qualifiedName },
          },
        ],
        label: object.qualifiedName,
      }}
    >
      <div className="group relative">
        <TreeButton
          active={active}
          className={surface === "sql" ? "pr-7" : undefined}
          depth={depth}
          icon={categoryIcon(object.kind)}
          label={object.name}
          onClick={() => onSelect(connection, object)}
          onDoubleClick={surface === "sql" ? () => onInsertName?.(selection) : undefined}
        />
        {surface === "sql" ? (
          <Tooltip
            align="end"
            className="absolute right-1 top-1/2 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            label={t("database.catalog.openInBrowse")}
            side="top"
          >
            <button
              aria-label={`${t("database.catalog.openInBrowse")}: ${object.name}`}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                onOpenInBrowse?.(selection);
              }}
              type="button"
            >
              <ExternalLink aria-hidden="true" className="size-3" />
            </button>
          </Tooltip>
        ) : null}
      </div>
    </AiContextTarget>
  );
}

async function buildObjectPrompt(
  connection: string,
  object: DatabaseObject,
  intent: "explain" | "query" | "relationships",
): Promise<string> {
  const details = await getDatabaseObjectDetails(connection, object.key);
  const context = {
    connection,
    object: details.object,
    columns: details.columns,
    indexes: details.indexes,
    constraints: details.constraints,
    triggers: details.triggers,
  };
  const request = intent === "explain"
    ? "Explain this database object, its purpose, and any notable design or safety concerns."
    : intent === "query"
      ? "Suggest useful read-only SQL queries for this database object."
      : "Explain this object's relationships and suggest appropriate joins to related objects.";
  return `${request}\n\nCatalog metadata (no credentials or row data):\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;
}

function ObjectDetailsPanel({
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

function TreeButton({ active, className, depth, description, expanded, icon, label, meta, onClick, onDoubleClick }: {
  active?: boolean;
  className?: string;
  depth: number;
  description?: string;
  expanded?: boolean;
  icon: React.ReactNode;
  label: string;
  meta?: string;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  return (
    <button
      aria-current={active ? "true" : undefined}
      aria-expanded={expanded}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 text-left font-mono text-[11px] transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active && "bg-muted/45 text-foreground",
        className,
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{ paddingLeft: 6 + depth * 12 }}
      title={description ? `${label} (${description})` : label}
      type="button"
    >
      {expanded === undefined ? <span className="size-3" /> : expanded ? <ChevronDown aria-hidden="true" className="size-3 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-3 shrink-0" />}
      <span aria-hidden="true" className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 truncate">
        {label}
        {description ? <span className="sr-only"> ({description})</span> : null}
      </span>
      {meta ? <span className="shrink-0 text-[9px] text-muted-foreground">{meta}</span> : null}
    </button>
  );
}

function DatabaseEngineIcon({ engine }: { engine: DatabaseConnection["engine"] }) {
  const icon: SimpleIcon =
    engine === "postgres" ? siPostgresql : engine === "mysql" ? siMysql : siSqlite;
  const color =
    engine === "postgres"
      ? "text-[#4169e1] dark:text-[#7d9cff]"
      : engine === "mysql"
        ? "text-[#e97b13] dark:text-[#f5a64a]"
        : "text-[#0f80b5] dark:text-[#55b8e6]";
  return (
    <svg
      aria-hidden="true"
      className={color}
      data-database-engine={engine}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d={icon.path} />
    </svg>
  );
}

function LoadingRow({ depth }: { depth: number }) {
  const t = useT();
  return <div className="flex items-center gap-1.5 py-1 text-[10px] text-muted-foreground" style={{ paddingLeft: 6 + depth * 12 }}><Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />{t("common.loading")}</div>;
}

function ErrorRow({ depth, error, onRetry }: { depth: number; error: string; onRetry: () => void }) {
  const t = useT();
  return <div className="flex min-w-0 items-center gap-1 py-1 pr-1 text-[10px] text-destructive" style={{ paddingLeft: 6 + depth * 12 }}><span className="min-w-0 flex-1 truncate" title={error}>{error}</span><Tooltip label={t("common.retry")}><button aria-label={t("common.retry")} className="rounded p-1 hover:bg-muted" onClick={onRetry} type="button"><RefreshCw aria-hidden="true" className="size-3" /></button></Tooltip></div>;
}

function categoryIcon(kind: DatabaseObjectKind): React.ReactNode {
  if (kind === "table") return <Table2 aria-hidden="true" className="size-3.5" />;
  if (kind === "view" || kind === "materializedView") return <Eye aria-hidden="true" className="size-3.5" />;
  if (kind === "function" || kind === "procedure") return <FunctionSquare aria-hidden="true" className="size-3.5" />;
  return <Workflow aria-hidden="true" className="size-3.5" />;
}

function schemaKey(connection: string, schema: string): string {
  return `${connection}::${schema}`;
}

function toggleList(current: string[], value: string): string[] {
  const next = current.filter((entry) => entry !== value);
  if (next.length === current.length) next.push(value);
  return next;
}

function addToList(current: string[], value: string): string[] {
  return current.includes(value) ? current : [...current, value];
}

function pruneList(
  current: string[],
  keep: (value: string) => boolean,
): string[] {
  const next = current.filter(keep);
  return next.length === current.length ? current : next;
}

function hasConnectionPrefix(value: string, connections: Set<string>): boolean {
  const separator = value.indexOf("::");
  return separator > 0 && connections.has(value.slice(0, separator));
}
