export const CONTEXT_KINDS = [
  "note",
  "project",
  "service",
  "file",
  "incident",
  "session",
] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];

export interface ContextRef {
  kind: ContextKind;
  id: string;
}

export interface ContextLink {
  target: string;
  label?: string;
  embed: boolean;
}

export interface ContextItem {
  ref: ContextRef;
  title: string;
  kind: ContextKind;
  excerpt?: string;
  projectPath?: string;
  path?: string;
  updatedAt?: string;
  tags: string[];
  aliases: string[];
  pinned: boolean;
  editable: boolean;
}

export interface ContextNote extends ContextItem {
  kind: "note";
  body: string;
  revision: string;
  links: ContextLink[];
  projectPaths: string[];
  frontmatter: Record<string, unknown>;
}

export interface ContextGraphNode {
  ref: ContextRef;
  title: string;
  kind: ContextKind;
  pinned: boolean;
  unresolved?: boolean;
}

export interface ContextGraphEdge {
  from: ContextRef;
  to: ContextRef;
  type: "wiki" | "belongs-to" | "mentions" | "depends-on";
}

export interface ContextGraph {
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  truncated: boolean;
}

export interface ContextAttachment {
  refs: ContextRef[];
  includePinned: boolean;
}

export interface ContextPreview {
  context: string;
  estimatedTokens: number;
  resolved: ContextItem[];
  missing: ContextRef[];
  warnings: string[];
}

export interface ContextLibrarySnapshot {
  vaultPath: string;
  items: ContextItem[];
  pinned: ContextRef[];
  diagnostics: string[];
  truncated: boolean;
}

export interface CreateContextNoteInput {
  title: string;
  body?: string;
  projectPaths?: string[];
  tags?: string[];
  aliases?: string[];
  sourceKey?: string;
}

export interface UpdateContextNoteInput {
  title: string;
  body: string;
  projectPaths: string[];
  tags: string[];
  aliases: string[];
  revision: string;
}
