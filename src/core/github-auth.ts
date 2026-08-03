import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitHubCredentialSelection,
  GitRepositoryDefinition,
  NoMoreIdeConfig,
} from "./types.js";

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 5_000;
const GH_MAX_BUFFER = 1024 * 1024;

export interface GitHubCliAccount {
  host: string;
  login: string;
  active: boolean;
  state: string;
}

export interface GitHubCliAccounts {
  available: boolean;
  accounts: GitHubCliAccount[];
  error?: string;
}

export interface ResolvedGitHubCredential {
  source: "gh" | "stored";
  host: string;
  login?: string;
  token: string;
}

export type GhRunner = (args: string[]) => Promise<string>;

export class GitHubCliAuth {
  constructor(private readonly run: GhRunner = runGh) {}

  async listAccounts(): Promise<GitHubCliAccounts> {
    try {
      const stdout = await this.run(["auth", "status", "--json", "hosts"]);
      return { available: true, accounts: parseGitHubCliAccounts(stdout) };
    } catch (error) {
      return {
        available: false,
        accounts: [],
        error: ghUnavailableMessage(error),
      };
    }
  }

  async token(host: string, login: string): Promise<string> {
    validateGitHubIdentity(host, login);
    try {
      const token = (await this.run([
        "auth",
        "token",
        "--hostname",
        host,
        "--user",
        login,
      ])).trim();
      if (!token) throw new Error("GitHub CLI returned an empty token.");
      return token;
    } catch {
      throw new Error(
        `GitHub CLI could not provide credentials for @${login} on ${host}. Re-authenticate with gh auth login or choose another account.`,
      );
    }
  }
}

export function parseGitHubCliAccounts(raw: string): GitHubCliAccount[] {
  const parsed = JSON.parse(raw) as { hosts?: unknown };
  if (!parsed.hosts || typeof parsed.hosts !== "object" || Array.isArray(parsed.hosts)) {
    throw new Error("GitHub CLI returned an unsupported account response.");
  }

  const accounts: GitHubCliAccount[] = [];
  for (const [host, entries] of Object.entries(parsed.hosts)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      const login = typeof candidate.login === "string" ? candidate.login.trim() : "";
      const entryHost = typeof candidate.host === "string" ? candidate.host.trim() : host;
      if (!login || !entryHost) continue;
      accounts.push({
        host: entryHost,
        login,
        active: candidate.active === true,
        state: typeof candidate.state === "string" ? candidate.state : "unknown",
      });
    }
  }
  return accounts;
}

export async function resolveGitHubCredential(
  config: NoMoreIdeConfig,
  repository: GitRepositoryDefinition | undefined,
  remoteHost: string,
  cli = new GitHubCliAuth(),
): Promise<ResolvedGitHubCredential> {
  const selection = repository?.githubCredential;
  if (selection?.host !== undefined && selection.host !== remoteHost) {
    throw new Error(
      `The selected GitHub credential is for ${selection.host}, but this repository uses ${remoteHost}.`,
    );
  }

  if (selection?.source === "gh") {
    return {
      source: "gh",
      host: selection.host,
      login: selection.login,
      token: await cli.token(selection.host, selection.login),
    };
  }

  const host = selection?.host ?? remoteHost;
  const token = config.githubTokens.find((entry) => entry.host === host)?.token;
  if (!token) {
    const suffix = selection?.source === "stored" ? ` for ${host}` : "";
    throw new Error(`No stored GitHub token configured${suffix}. Choose a GitHub CLI account or connect GitHub.`);
  }
  return { source: "stored", host, token };
}

export function publicCredential(
  credential: ResolvedGitHubCredential,
): GitHubCredentialSelection {
  if (credential.source === "gh") {
    if (!credential.login) throw new Error("Resolved GitHub CLI credential is missing its login.");
    return { source: "gh", host: credential.host, login: credential.login };
  }
  return { source: "stored", host: credential.host };
}

async function runGh(args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]) {
    delete env[name];
  }
  env.GH_PROMPT_DISABLED = "1";
  const { stdout } = await execFileAsync("gh", args, {
    encoding: "utf8",
    env,
    maxBuffer: GH_MAX_BUFFER,
    timeout: GH_TIMEOUT_MS,
  });
  return stdout;
}

function validateGitHubIdentity(host: string, login: string): void {
  const hasControlCharacter = [...host, ...login].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!host.trim() || !login.trim() || hasControlCharacter) {
    throw new Error("Invalid GitHub host or account login.");
  }
}

function ghUnavailableMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "GitHub CLI is not installed or is not available on PATH.";
  return "GitHub CLI account discovery is unavailable. Update gh and run gh auth login.";
}
