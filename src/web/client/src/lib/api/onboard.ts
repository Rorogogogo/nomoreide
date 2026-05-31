import { requestJson } from "./client.js";

export type OnboardConfidence = "high" | "medium" | "low";

export interface OnboardProposal {
  name: string;
  kind: "local" | "docker-compose";
  command?: string;
  cwd: string;
  port?: number;
  env?: Record<string, string>;
  description?: string;
  composeFile?: string;
  composeService?: string;
  /** One-shot install step to run before the first start (not persisted). */
  installCommand?: string;
  confidence: OnboardConfidence;
  reason: string;
}

export interface OnboardProfile {
  name: string;
  clonePath: string;
  languages: string[];
  node?: {
    packageManager: string;
    scripts: Record<string, string>;
    hasDevScript: boolean;
    hasStartScript: boolean;
  };
  python?: {
    hasRequirements: boolean;
    hasPyproject: boolean;
    hasManagePy: boolean;
    framework: string;
  };
  docker?: { hasDockerfile: boolean; composeFile?: string; composeServices: string[] };
  envKeys: string[];
  readmeExcerpt?: string;
}

export interface OnboardDatabaseProposal {
  name: string;
  engine: "postgres" | "mysql";
  url: string;
  composeService?: string;
  confidence: OnboardConfidence;
  reason: string;
}

export interface OnboardScanResult {
  profile: OnboardProfile;
  proposals: OnboardProposal[];
  databases: OnboardDatabaseProposal[];
}

const JSON_HEADERS = { "content-type": "application/json" };

/** Clone + scan a repo URL and return its profile plus heuristic proposals. */
export async function scanRepo(url: string): Promise<OnboardScanResult> {
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
}

/** Register a confirmed proposal as a service, optionally starting it. */
export async function registerOnboarded(
  proposal: OnboardProposal,
  start: boolean,
  database?: OnboardDatabaseProposal,
): Promise<void> {
  const payload = database
    ? { name: database.name, engine: database.engine, url: database.url }
    : undefined;
  await requestJson("/api/onboard/register", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...proposal, start, database: payload }),
  });
}

export interface InstallStreamHandlers {
  onLine: (line: { stream: "stdout" | "stderr"; text: string }) => void;
  onDone: (exitCode: number | null) => void;
  onError: (message: string) => void;
}

/**
 * Stream a one-shot install command's output. The endpoint is POST (it carries
 * a body), so we read the SSE stream off `fetch` rather than using EventSource.
 */
export async function streamInstall(
  params: { clonePath: string; command: string },
  handlers: InstallStreamHandlers,
): Promise<void> {
  const response = await fetch("/api/onboard/install/stream", {
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
}

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
