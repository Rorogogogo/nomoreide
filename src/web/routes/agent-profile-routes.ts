import type { IncomingMessage } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  applyProfile,
  createProfile,
  deleteProfile,
  exportProfile,
  getProfile,
  importProfile,
  listProfiles,
  previewProfileApply,
  profileSchema,
  snapshotProfileFromAgent,
  updateProfile,
} from "../../core/agent-profiles/index.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

const agentSchema = z.enum(["claude", "codex", "antigravity"]);

const createBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const patchBodySchema = profileSchema
  .pick({ description: true, mcps: true, skills: true, plugins: true })
  .partial();

const snapshotBodySchema = z.object({
  agent: agentSchema,
  name: z.string().min(1),
  description: z.string().optional(),
});

const applyBodySchema = z.object({
  agent: agentSchema,
  skip: z
    .object({
      mcps: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional(),
      plugins: z.array(z.string()).optional(),
    })
    .optional(),
});

const importBodySchema = z.object({
  archivePath: z.string().min(1).optional(),
  force: z.boolean().optional(),
  as: z.string().min(1).optional(),
  credentials: z.record(z.string()).optional(),
});

/**
 * Agent Profiles (ROR-62). `GET /profiles` is read-on-mount — it has a
 * matching handler in `website/src/mock-api.ts`, as do the profile detail and
 * apply-preview endpoints the panel renders. Import accepts either a JSON
 * body naming a local archive or raw `.tar.gz` bytes (browser upload).
 */
export const agentProfileRoutes: Route[] = [
  route(["GET", "POST"], "/api/agent-env/profiles", async ({ request, response }) => {
    try {
      if (request.method === "GET") {
        sendJson(response, { ok: true, profiles: await listProfiles() });
        return;
      }
      const body = createBodySchema.safeParse(await readJson(request));
      if (!body.success) {
        sendJson(response, { ok: false, error: "name is required." }, 400);
        return;
      }
      const profile = await createProfile(body.data);
      sendJson(response, { ok: true, profile });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("POST", "/api/agent-env/profiles/snapshot", async ({ request, response, cwd }) => {
    const body = snapshotBodySchema.safeParse(await readJson(request));
    if (!body.success) {
      sendJson(response, { ok: false, error: "agent and name are required." }, 400);
      return;
    }
    try {
      const profile = await snapshotProfileFromAgent({ ...body.data, cwd });
      sendJson(response, { ok: true, profile });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("POST", "/api/agent-env/profiles/import", async ({ request, response }) => {
    try {
      const contentType = request.headers["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        const body = importBodySchema.safeParse(await readJson(request));
        if (!body.success || !body.data.archivePath) {
          sendJson(response, { ok: false, error: "archivePath is required." }, 400);
          return;
        }
        sendJson(response, { ok: true, ...(await importProfile({ ...body.data, archivePath: body.data.archivePath })) });
        return;
      }

      // Raw upload: buffer the .tar.gz to a temp file, then import it.
      const bytes = await readRawBody(request);
      if (bytes.length === 0) {
        sendJson(response, { ok: false, error: "Empty upload." }, 400);
        return;
      }
      const dir = await mkdtemp(path.join(tmpdir(), "nomoreide-profile-upload-"));
      try {
        const archivePath = path.join(dir, "profile.tar.gz");
        await writeFile(archivePath, bytes);
        const force = new URL(request.url ?? "/", "http://localhost").searchParams.get("force") === "1";
        sendJson(response, { ok: true, ...(await importProfile({ archivePath, force })) });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  patternRoute(
    /^\/api\/agent-env\/profiles\/([^/]+)\/(apply-preview|apply|export)$/,
    ["name", "action"],
    async ({ request, response, params, cwd }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const name = decodeURIComponent(params.name);
      try {
        if (params.action === "export") {
          const body = await readJson(request);
          const outputPath =
            typeof body.outputPath === "string" && body.outputPath.length > 0
              ? body.outputPath
              : undefined;
          sendJson(response, { ok: true, ...(await exportProfile({ name, outputPath, cwd })) });
          return;
        }

        const body = applyBodySchema.safeParse(await readJson(request));
        if (!body.success) {
          sendJson(response, { ok: false, error: "agent is required." }, 400);
          return;
        }
        if (params.action === "apply-preview") {
          sendJson(response, {
            ok: true,
            ...(await previewProfileApply({ cwd, name, agent: body.data.agent })),
          });
          return;
        }
        sendJson(response, {
          ok: true,
          ...(await applyProfile({ cwd, name, agent: body.data.agent, skip: body.data.skip })),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),

  patternRoute(
    /^\/api\/agent-env\/profiles\/([^/]+)$/,
    ["name"],
    async ({ request, response, params }) => {
      const name = decodeURIComponent(params.name);
      try {
        if (request.method === "GET") {
          sendJson(response, { ok: true, profile: await getProfile(name) });
          return;
        }
        if (request.method === "PATCH") {
          const body = patchBodySchema.safeParse(await readJson(request));
          if (!body.success) {
            sendJson(response, { ok: false, error: "Invalid profile patch." }, 400);
            return;
          }
          sendJson(response, { ok: true, profile: await updateProfile(name, body.data) });
          return;
        }
        if (request.method === "DELETE") {
          await deleteProfile(name);
          sendJson(response, { ok: true });
          return;
        }
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
      } catch (error) {
        const status = errorMessage(error).includes("not found") ? 404 : 500;
        sendJson(response, { ok: false, error: errorMessage(error) }, status);
      }
    },
  ),
];

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
