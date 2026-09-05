import {
  Braces,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
} from "lucide-react";
import { useMemo } from "react";
import { siMysql, siPostgresql, siSqlite, type SimpleIcon } from "simple-icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  getDatabaseObjectDetails,
  type DatabaseCapabilities,
  type DatabaseConnection,
  type DatabaseObject,
  type DatabaseObjectKind,
  type DatabaseSchema,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AiContextTarget } from "@/features/agent/context-menu/ai-context-menu";
import { categoryIcon, schemaKey } from "./catalog-helpers";
import {
  CATEGORY_ORDER,
  SAMPLEABLE,
  type ConnectionCatalog,
  type ExplorerSurface,
  type LoadState,
  type SelectedCatalogObject,
} from "./catalog-model";

/**
 * The left-hand catalog tree: a schema's sections, the objects inside them,
 * and the row primitives all three share.
 *
 * Split out of `database-explorer.tsx`, which keeps the loading state and the
 * selection the tree reports back to.
 */

export function SchemaBranch({
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

export function CatalogObjectRow({
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

export function TreeButton({ active, className, depth, description, expanded, icon, label, meta, onClick, onDoubleClick }: {
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

export function DatabaseEngineIcon({ engine }: { engine: DatabaseConnection["engine"] }) {
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

export function LoadingRow({ depth }: { depth: number }) {
  const t = useT();
  return <div className="flex items-center gap-1.5 py-1 text-[10px] text-muted-foreground" style={{ paddingLeft: 6 + depth * 12 }}><Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />{t("common.loading")}</div>;
}

export function ErrorRow({ depth, error, onRetry }: { depth: number; error: string; onRetry: () => void }) {
  const t = useT();
  return <div className="flex min-w-0 items-center gap-1 py-1 pr-1 text-[10px] text-destructive" style={{ paddingLeft: 6 + depth * 12 }}><span className="min-w-0 flex-1 truncate" title={error}>{error}</span><Tooltip label={t("common.retry")}><button aria-label={t("common.retry")} className="rounded p-1 hover:bg-muted" onClick={onRetry} type="button"><RefreshCw aria-hidden="true" className="size-3" /></button></Tooltip></div>;
}
