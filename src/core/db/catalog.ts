import type { ColumnInfo, TableRef } from "./driver.js";

export type DatabaseObjectKind =
  | "table"
  | "view"
  | "materializedView"
  | "function"
  | "procedure"
  | "sequence";

export interface DatabaseCapabilities {
  objectKinds: DatabaseObjectKind[];
  tableDetails: Array<"columns" | "indexes" | "constraints" | "triggers">;
}

export interface DatabaseSchema {
  name: string;
}

export interface DatabaseObject {
  /** Opaque server-issued key; callers must never construct or parse it. */
  key: string;
  schema: string;
  name: string;
  kind: DatabaseObjectKind;
  qualifiedName: string;
  /** Engine-native identity included only to disambiguate live catalog entries. */
  nativeId?: string;
}

export interface DatabaseIndex {
  name: string;
  definition: string;
  unique: boolean;
}

export interface DatabaseConstraint {
  name: string;
  type: string;
  definition: string;
}

export interface DatabaseTrigger {
  name: string;
  definition: string;
}

export interface DatabaseObjectDetails {
  object: DatabaseObject;
  columns: ColumnInfo[];
  indexes: DatabaseIndex[];
  constraints: DatabaseConstraint[];
  triggers: DatabaseTrigger[];
  /** Function/view/trigger definition, capped before it leaves the core. */
  definition?: string;
  /** Executable DDL that recreates this object, capped before it leaves the core. */
  createScript?: string;
}

interface ObjectIdentity {
  schema: string;
  name: string;
  kind: DatabaseObjectKind;
  nativeId?: string;
}

const DEFINITION_LIMIT = 64 * 1024;

export function objectKey(identity: ObjectIdentity): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

export function objectFromIdentity(identity: ObjectIdentity): DatabaseObject {
  return {
    ...identity,
    key: objectKey(identity),
    qualifiedName:
      identity.schema === "main"
        ? identity.name
        : `${identity.schema}.${identity.name}`,
  };
}

/** Resolve an opaque key only by equality against a freshly-read live catalog. */
export function resolveCatalogObject(
  objects: DatabaseObject[],
  key: string,
): DatabaseObject {
  const object = objects.find((candidate) => candidate.key === key);
  if (!object) throw new Error("Database object was not found in the live catalog.");
  return object;
}

export function tableRefForObject(object: DatabaseObject): TableRef {
  if (object.kind !== "table" && object.kind !== "view" && object.kind !== "materializedView") {
    throw new Error(`Database object "${object.qualifiedName}" cannot be sampled.`);
  }
  return {
    schema: object.schema,
    name: object.name,
    qualifiedName: object.qualifiedName,
  };
}

export function capDefinition(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= DEFINITION_LIMIT
    ? value
    : `${value.slice(0, DEFINITION_LIMIT)}\n-- Definition truncated by NoMoreIDE.`;
}
