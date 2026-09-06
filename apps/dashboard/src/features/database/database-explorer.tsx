import { useEffect, useState } from "react";
import {
  ListTree,
  Pencil,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AiContextTarget } from "@/features/agent/context-menu/ai-context-menu";
import {
  getDatabaseCapabilities,
  getDatabaseObjects,
  getDatabaseSchemas,
  type DatabaseConnection,
  type DatabaseObject,
} from "@/lib/api";
import { useT, } from "@/lib/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";
import {
  DatabaseEngineIcon,
  ErrorRow,
  LoadingRow,
  SchemaBranch,
  TreeButton,
} from "./catalog-tree";
import { ObjectDetailsPanel } from "./object-details-panel";
import { addToList, hasConnectionPrefix, pruneList, schemaKey, toggleList } from "./catalog-helpers";
import type {
  ConnectionCatalog,
  LoadState,
  ExplorerSurface,
  SelectedCatalogObject,
} from "./catalog-model";
export type { SelectedCatalogObject } from "./catalog-model";
import { DbAddMenu } from "./db-add-menu";
import "../git/file-viewer-theme.css";

const NOOP = () => {};

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
