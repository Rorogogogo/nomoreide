import { execFile } from "node:child_process";

const SKILLS_SEARCH_URL = "https://skills.sh/api/search";
const SKILLS_CLI_VERSION = "1.5.20";
const SEARCH_LIMIT = 6;
const SEARCH_TIMEOUT_MS = 8_000;
const USE_TIMEOUT_MS = 60_000;
const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;
const MAX_SKILL_PROMPT_BYTES = 256 * 1024;
const MAX_COMBINED_PROMPT_BYTES = 512 * 1024;
const GITHUB_SOURCE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const SKILL_SELECTOR = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,199})$/;

export interface RemoteSkillResult {
  id: string;
  name: string;
  source: string;
  useSource: string;
  installs: number;
  url: string;
}

export interface OneTimeSkillSelection {
  name: string;
  source: string;
}

interface SkillsSearchPayload {
  skills?: unknown[];
}

interface SkillsSearchEntry {
  id?: unknown;
  installs?: unknown;
  name?: unknown;
  source?: unknown;
}

export class OneTimeSkillError extends Error {
  constructor(
    readonly code:
      | "invalid_query"
      | "invalid_response"
      | "invalid_source"
      | "network"
      | "runtime_missing"
      | "skill_unavailable"
      | "timeout"
      | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "OneTimeSkillError";
  }
}

function selectorFor(id: string, source: string): string | null {
  const prefix = `${source}/`;
  if (!id.startsWith(prefix)) return null;
  const selector = id.slice(prefix.length);
  return SKILL_SELECTOR.test(selector) ? selector : null;
}

function normalizeSearchEntry(value: unknown): RemoteSkillResult | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as SkillsSearchEntry;
  if (
    typeof entry.id !== "string" ||
    typeof entry.name !== "string" ||
    typeof entry.source !== "string" ||
    !GITHUB_SOURCE.test(entry.source)
  ) {
    return null;
  }
  const selector = selectorFor(entry.id, entry.source);
  if (!selector) return null;
  return {
    id: entry.id,
    name: entry.name.slice(0, 200),
    source: entry.source,
    useSource: `${entry.source}@${selector}`,
    installs:
      typeof entry.installs === "number" && Number.isFinite(entry.installs)
        ? Math.max(0, Math.trunc(entry.installs))
        : 0,
    url: `https://skills.sh/${entry.id}`,
  };
}

async function readResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new OneTimeSkillError(
          "invalid_response",
          "skills.sh returned too much search data.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

export async function searchRemoteSkills(
  rawQuery: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RemoteSkillResult[]> {
  const query = rawQuery.trim();
  if (query.length < 2 || query.length > 100) {
    throw new OneTimeSkillError("invalid_query", "Skill search must be 2–100 characters.");
  }

  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const url = new URL(SKILLS_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(SEARCH_LIMIT));

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { signal });
  } catch (error) {
    if (signal.aborted) {
      throw new OneTimeSkillError("timeout", "Skill search timed out.");
    }
    throw new OneTimeSkillError(
      "network",
      `Could not search skills.sh: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new OneTimeSkillError(
      "network",
      `skills.sh search failed with HTTP ${response.status}.`,
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SEARCH_RESPONSE_BYTES
  ) {
    throw new OneTimeSkillError("invalid_response", "skills.sh returned too much search data.");
  }
  let payload: SkillsSearchPayload;
  try {
    const text = await readResponseText(response, MAX_SEARCH_RESPONSE_BYTES);
    payload = JSON.parse(text) as SkillsSearchPayload;
  } catch (error) {
    if (error instanceof OneTimeSkillError) throw error;
    throw new OneTimeSkillError("invalid_response", "skills.sh returned invalid JSON.");
  }
  if (!Array.isArray(payload.skills)) {
    throw new OneTimeSkillError("invalid_response", "skills.sh returned an invalid search result.");
  }
  return payload.skills
    .map(normalizeSearchEntry)
    .filter((item): item is RemoteSkillResult => item !== null)
    .slice(0, SEARCH_LIMIT);
}

export function validateOneTimeSkill(selection: OneTimeSkillSelection): void {
  const at = selection.source.lastIndexOf("@");
  const repository = selection.source.slice(0, at);
  const selector = selection.source.slice(at + 1);
  if (
    at <= 0 ||
    !GITHUB_SOURCE.test(repository) ||
    !SKILL_SELECTOR.test(selector) ||
    selection.name.trim().length === 0 ||
    selection.name.length > 200
  ) {
    throw new OneTimeSkillError("invalid_source", "The selected skill source is invalid.");
  }
}

export function resolveOneTimeSkill(
  selection: OneTimeSkillSelection,
  options: {
    execFile?: typeof execFile;
    platform?: NodeJS.Platform;
  } = {},
): Promise<string> {
  validateOneTimeSkill(selection);
  const executable = (options.platform ?? process.platform) === "win32" ? "npx.cmd" : "npx";
  const run = options.execFile ?? execFile;
  return new Promise((resolve, reject) => {
    run(
      executable,
      ["--yes", `skills@${SKILLS_CLI_VERSION}`, "use", selection.source],
      {
        env: {
          ...process.env,
          CI: "1",
          NO_COLOR: "1",
          npm_config_yes: "true",
        },
        maxBuffer: MAX_SKILL_PROMPT_BYTES,
        timeout: USE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          const prompt = stdout.toString();
          if (!prompt.trim()) {
            reject(
              new OneTimeSkillError(
                "skill_unavailable",
                "The skills CLI returned an empty skill.",
              ),
            );
            return;
          }
          resolve(prompt);
          return;
        }
        const processError = error as NodeJS.ErrnoException & { killed?: boolean };
        if (processError.code === "ENOENT") {
          reject(
            new OneTimeSkillError(
              "runtime_missing",
              "Node.js and npm are required to use a temporary skill.",
            ),
          );
          return;
        }
        if (processError.killed || processError.code === "ETIMEDOUT") {
          reject(new OneTimeSkillError("timeout", "Loading the temporary skill timed out."));
          return;
        }
        if (processError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new OneTimeSkillError("too_large", "The temporary skill is too large to use."));
          return;
        }
        const detail = stderr.toString().trim();
        reject(
          new OneTimeSkillError(
            "skill_unavailable",
            detail || "The temporary skill could not be loaded.",
          ),
        );
      },
    );
  });
}

export function composeOneTimeSkillPrompt(skillPrompt: string, userPrompt: string): string {
  const combined = `${skillPrompt.trimEnd()}\n\nUser's request:\n${userPrompt}`;
  if (Buffer.byteLength(combined, "utf8") > MAX_COMBINED_PROMPT_BYTES) {
    throw new OneTimeSkillError(
      "too_large",
      "The temporary skill and task are too large to send together.",
    );
  }
  return combined;
}
