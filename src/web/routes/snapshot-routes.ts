import { SnapshotManager } from "../../core/snapshot-manager.js";
import { selectedGitCwd } from "../dashboard.js";
import { readJson, sendJson, sendText } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

const SHA_PATTERN = /^[0-9a-f]{4,40}$/i;

function validSha(sha: string): boolean {
  return SHA_PATTERN.test(sha);
}

/**
 * Working-tree snapshots (refs/nomoreide/snapshots) and agent change-sets.
 * Restore is the destructive endpoint: SnapshotManager guards it by refusing
 * shas outside the snapshot namespace and snapshotting before restoring; the
 * UI confirms before calling it. There is deliberately no MCP restore tool.
 */
export const snapshotRoutes: Route[] = [
  route("GET", "/api/snapshots", async ({ response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    try {
      const snapshots = await new SnapshotManager(gitCwd).list();
      sendJson(response, { ok: true, snapshots });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/snapshots", async ({ request, response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const body = await readJson(request);
    const label = typeof body.label === "string" && body.label.trim()
      ? body.label.trim()
      : "manual snapshot";
    try {
      const manager = new SnapshotManager(gitCwd);
      const snapshot = await manager.snapshot(label);
      await manager.prune();
      sendJson(response, { ok: true, snapshot });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/snapshots\/([^/]+)\/files$/,
    ["sha"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      if (!validSha(params.sha)) {
        sendJson(response, { ok: false, error: "Invalid snapshot sha" }, 400);
        return;
      }
      const gitCwd = await selectedGitCwd(configStore, cwd);
      try {
        const files = await new SnapshotManager(gitCwd).changedFiles(params.sha);
        sendJson(response, { ok: true, files });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/snapshots\/([^/]+)\/diff$/,
    ["sha"],
    async ({ request, response, url, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      if (!validSha(params.sha)) {
        sendJson(response, { ok: false, error: "Invalid snapshot sha" }, 400);
        return;
      }
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const path = url.searchParams.get("path")?.trim() || undefined;
      try {
        const diff = await new SnapshotManager(gitCwd).diff(params.sha, path);
        sendText(response, diff);
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/snapshots\/([^/]+)\/restore$/,
    ["sha"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      if (!validSha(params.sha)) {
        sendJson(response, { ok: false, error: "Invalid snapshot sha" }, 400);
        return;
      }
      const gitCwd = await selectedGitCwd(configStore, cwd);
      try {
        const result = await new SnapshotManager(gitCwd).restore(params.sha);
        sendJson(response, { ok: true, ...result });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  // Agent change-sets: sessions recorded by the MCP recording wrapper, each
  // pinned to the snapshot taken before the session's first tool call.
  route("GET", "/api/agent/change-sets", async ({ response, agentSessions }) => {
    sendJson(response, { ok: true, sessions: await agentSessions.list() });
  }),

  patternRoute(
    /^\/api\/agent\/change-sets\/([^/]+)$/,
    ["id"],
    async ({ request, response, agentSessions, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const session = await agentSessions.get(params.id);
      if (!session) {
        sendJson(response, { ok: false, error: "Unknown session" }, 404);
        return;
      }
      if (!session.snapshotSha) {
        sendJson(response, { ok: true, session, files: [] });
        return;
      }
      try {
        const files = await new SnapshotManager(session.repoPath).changedFiles(
          session.snapshotSha,
        );
        sendJson(response, { ok: true, session, files });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  // Restore via the change-set so it runs in the session's repo (which may
  // not be the currently selected repository).
  patternRoute(
    /^\/api\/agent\/change-sets\/([^/]+)\/restore$/,
    ["id"],
    async ({ request, response, agentSessions, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const session = await agentSessions.get(params.id);
      if (!session?.snapshotSha) {
        sendJson(response, { ok: false, error: "Session has no snapshot" }, 404);
        return;
      }
      try {
        const result = await new SnapshotManager(session.repoPath).restore(
          session.snapshotSha,
        );
        sendJson(response, { ok: true, ...result });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/agent\/change-sets\/([^/]+)\/diff$/,
    ["id"],
    async ({ request, response, url, agentSessions, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const session = await agentSessions.get(params.id);
      if (!session?.snapshotSha) {
        sendJson(response, { ok: false, error: "Session has no snapshot" }, 404);
        return;
      }
      const path = url.searchParams.get("path")?.trim() || undefined;
      try {
        const diff = await new SnapshotManager(session.repoPath).diff(
          session.snapshotSha,
          path,
        );
        sendText(response, diff);
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),
];
