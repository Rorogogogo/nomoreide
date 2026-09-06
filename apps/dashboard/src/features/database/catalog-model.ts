import type {
  DatabaseCapabilities,
  DatabaseObject,
  DatabaseObjectKind,
  DatabaseSchema,
} from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n";

/**
 * Shapes the explorer's tree, details panel and page all read.
 *
 * They live here rather than in any one of those modules so none of them has
 * to import another just for a type.
 */

export interface ConnectionCatalog {
  capabilities: DatabaseCapabilities;
  schemas: DatabaseSchema[];
}

export interface LoadState<T> {
  value?: T;
  loading?: boolean;
  error?: string;
}

export type ObjectDetailTab = "data" | "structure" | "script";

export type SelectedCatalogObject = {
  connection: string;
  object: DatabaseObject;
};

/** Catalog sections, in the order the tree renders them. */
export const CATEGORY_ORDER: Array<{
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

/** Kinds that can be previewed by sampling rows. */
export const SAMPLEABLE = new Set<DatabaseObjectKind>([
  "table",
  "view",
  "materializedView",
]);

/** Which half of the explorer is showing: the browser, or the SQL editor. */
export type ExplorerSurface = "browse" | "sql";
