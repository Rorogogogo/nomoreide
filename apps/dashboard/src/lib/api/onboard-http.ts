/** Node HTTP-server implementation of {@link OnboardApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import { apiFetch } from "./desktop-runtime.js";
import type {
  InstallStreamHandlers,
  OnboardApi,
  OnboardDatabaseProposal,
  OnboardProfile,
  OnboardProposal,
} from "./onboard-api.js";

const JSON_HEADERS = { "content-type": "application/json" };

function parseSseChunk(chunk: string, handlers: InstallStreamHandlers): void {
  let event = "message";
  let data = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (event === "output") {
      handlers.onLine(parsed as { stream: "stdout" | "stderr"; text: string });
    } else if (event === "done") {
      handlers.onDone((parsed.exitCode as number | null) ?? null);
    } else if (event === "error") {
      handlers.onError((parsed.error as string) ?? "Install failed.");
    }
  } catch {
    // ignore malformed event chunk
  }
}

export const httpOnboardApi: OnboardApi = {
  async scanRepo(url) {
    const body = await requestJson<{
      profile: OnboardProfile;
      proposals: OnboardProposal[];
      databases?: OnboardDatabaseProposal[];
    }>("/api/onboard/scan", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ url }),
    });
    return { profile: body.profile, proposals: body.proposals, databases: body.databases ?? [] };
  },

  async registerOnboarded(proposal, start, database) {
    const payload = database
      ? { name: database.name, engine: database.engine, url: database.url }
      : undefined;
    await requestJson("/api/onboard/register", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...proposal, start, database: payload }),
    });
  },

  async streamInstall(params, handlers) {
    const response = await apiFetch("/api/onboard/install/stream", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(params),
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => undefined);
      handlers.onError(body?.error || response.statusText);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) parseSseChunk(chunk, handlers);
    }
  },
};
