import type { ContextApi } from "./context-api.js";
import { contextHttpApi } from "./context-http.js";

const api: ContextApi = contextHttpApi;

export const listContext = api.list;
export const getContextGraph = api.graph;
export const getContextNote = api.getNote;
export const createContextNote = api.createNote;
export const updateContextNote = api.updateNote;
export const deleteContextNote = api.deleteNote;
export const setContextPins = api.setPinned;
export const previewContext = api.preview;

export type {
  ContextAttachment,
  ContextGraph,
  ContextItem,
  ContextKind,
  ContextLibrarySnapshot,
  ContextLink,
  ContextNote,
  ContextPreview,
  ContextQuery,
  ContextRef,
} from "./context-api.js";
export { CONTEXT_KINDS } from "./context-api.js";
