import { z } from "zod";
import {
  ContextConflictError,
  ContextValidationError,
} from "../../core/context-library.js";
import { CONTEXT_KINDS } from "../../core/context-types.js";
import { readJson, sendJson } from "../http-utils.js";
import { patternRoute, route, type Route } from "./context.js";

const contextRefSchema = z.object({
  kind: z.enum(CONTEXT_KINDS),
  id: z.string().trim().min(1).max(1_000),
}).strict();

const noteCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(1024 * 1024).optional(),
  projectPaths: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  sourceKey: z.string().trim().min(1).max(1_000).optional(),
}).strict();

const noteUpdateSchema = noteCreateSchema.extend({
  body: z.string().max(1024 * 1024),
  projectPaths: z.array(z.string().trim().min(1).max(2_000)).max(50),
  tags: z.array(z.string().trim().min(1).max(100)).max(100),
  aliases: z.array(z.string().trim().min(1).max(120)).max(100),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}).omit({ sourceKey: true }).strict();

const pinsSchema = z.object({ refs: z.array(contextRefSchema).max(200) }).strict();
const previewSchema = z.object({
  attachment: z.object({
    refs: z.array(contextRefSchema).max(200),
    includePinned: z.boolean(),
  }).strict(),
  projectPath: z.string().trim().min(1).max(2_000).optional(),
}).strict();

function idParam(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(id)) throw new ContextValidationError("Invalid context note id.");
  return id;
}

function sendContextError(response: Parameters<typeof sendJson>[0], error: unknown): void {
  if (error instanceof ContextConflictError) {
    sendJson(response, { ok: false, error: error.message, current: error.current }, 409);
    return;
  }
  if (error instanceof ContextValidationError) {
    sendJson(response, { ok: false, error: error.message }, 400);
    return;
  }
  throw error;
}

export const contextLibraryRoutes: Route[] = [
  route("GET", "/api/context", async ({ response, contextLibrary, url }) => {
    const kinds = url.searchParams.get("kinds")?.split(",").filter(
      (kind): kind is (typeof CONTEXT_KINDS)[number] => CONTEXT_KINDS.includes(kind as (typeof CONTEXT_KINDS)[number]),
    );
    sendJson(response, {
      ok: true,
      ...(await contextLibrary.list({
        q: url.searchParams.get("q") ?? undefined,
        projectPath: url.searchParams.get("projectPath") ?? undefined,
        kinds,
      })),
    });
  }),

  route("GET", "/api/context/graph", async ({ response, contextLibrary, url }) => {
    const kinds = url.searchParams.get("kinds")?.split(",").filter(
      (kind): kind is (typeof CONTEXT_KINDS)[number] => CONTEXT_KINDS.includes(kind as (typeof CONTEXT_KINDS)[number]),
    );
    sendJson(response, {
      ok: true,
      graph: await contextLibrary.graph({
        q: url.searchParams.get("q") ?? undefined,
        projectPath: url.searchParams.get("projectPath") ?? undefined,
        kinds,
      }),
    });
  }),

  route("POST", "/api/context/notes", async ({ request, response, contextLibrary }) => {
    const parsed = noteCreateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendJson(response, { ok: false, error: "Invalid context note." }, 400);
      return;
    }
    try {
      sendJson(response, { ok: true, note: await contextLibrary.createNote(parsed.data) }, 201);
    } catch (error) {
      sendContextError(response, error);
    }
  }),

  patternRoute(/^\/api\/context\/notes\/([^/]+)$/, ["id"], async ({ request, response, params, contextLibrary }) => {
    try {
      const id = idParam(params.id);
      if (request.method === "GET") {
        const note = await contextLibrary.getNote(id);
        if (!note) sendJson(response, { ok: false, error: "Context note not found." }, 404);
        else sendJson(response, { ok: true, note });
        return;
      }
      if (request.method === "PUT") {
        const parsed = noteUpdateSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          sendJson(response, { ok: false, error: "Invalid context note update." }, 400);
          return;
        }
        sendJson(response, { ok: true, note: await contextLibrary.updateNote(id, parsed.data) });
        return;
      }
      if (request.method === "DELETE") {
        const parsed = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(await readJson(request));
        if (!parsed.success) {
          sendJson(response, { ok: false, error: "A valid note revision is required." }, 400);
          return;
        }
        await contextLibrary.deleteNote(id, parsed.data.revision);
        sendJson(response, { ok: true });
        return;
      }
      sendJson(response, { ok: false, error: "Method not allowed" }, 405);
    } catch (error) {
      sendContextError(response, error);
    }
  }),

  route("PUT", "/api/context/pins", async ({ request, response, contextLibrary }) => {
    const parsed = pinsSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendJson(response, { ok: false, error: "Invalid pinned context." }, 400);
      return;
    }
    sendJson(response, { ok: true, pinned: await contextLibrary.setPinned(parsed.data.refs) });
  }),

  route("POST", "/api/context/preview", async ({ request, response, contextLibrary }) => {
    const parsed = previewSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendJson(response, { ok: false, error: "Invalid context preview request." }, 400);
      return;
    }
    sendJson(response, { ok: true, preview: await contextLibrary.preview(parsed.data.attachment, parsed.data.projectPath) });
  }),
];
