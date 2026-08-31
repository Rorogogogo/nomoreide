import { getSelectedGitRepository, selectedGitCwd } from "../dashboard.js";
import { GitManager, type GitCompareSummary } from "../../core/git-manager.js";
import { GitHubApiError, GitHubManager, githubOAuthBase } from "../../core/github-manager.js";
import { GitHubCliAuth } from "../../core/github-auth.js";
import type { GitHubCredentialSelection } from "../../core/types.js";
import { readForm, readJson, requiredFormValue, sendJson, sendText } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";
import { requireGitHubContext, optionalGitHubContext } from "./github-context.js";

const DEVICE_CODE_PATH = "/login/device/code";
const ACCESS_TOKEN_PATH = "/login/oauth/access_token";
const GITHUB_SCOPES = "repo workflow read:org";
const DEFAULT_GITHUB_CLIENT_ID = "Ov23litfv3LE0LevxlT2";

interface PRTemplateCompare {
  base: string;
  head: string;
  aheadBy: number;
  headSha: string | null;
  commits: Array<{ sha: string; message: string }>;
  files: Array<{
    path: string;
    status: string;
    additions?: number;
    deletions?: number;
    changes?: number;
  }>;
  ciStatus?: Awaited<ReturnType<GitHubManager["getCommitChecks"]>>;
}

function getClientId(): string | undefined {
  return process.env.NOMOREIDE_GITHUB_CLIENT_ID?.trim() || DEFAULT_GITHUB_CLIENT_ID;
}

/**
 * Who a freshly stored token belongs to. Captured once at connect time so the
 * status route can report the account (and its avatar) without spending an API
 * call on every check. Best-effort: a failure here must not fail the login.
 */
async function fetchGitHubProfile(
  token: string,
): Promise<{ login: string; avatarUrl?: string } | undefined> {
  try {
    const viewer = await new GitHubManager(token, "", "").viewer();
    if (!viewer.login) return undefined;
    return { login: viewer.login, avatarUrl: viewer.avatar_url };
  } catch {
    return undefined;
  }
}

/** Public avatar for a login we know without having called the API. */
function avatarForLogin(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=64`;
}

async function buildPRTemplate(gitCwd: string, manager: GitHubManager) {
  const git = new GitManager(gitCwd);
  const warnings: string[] = [];
  const status = await git.status().catch((error) => {
    warnings.push(`Could not read local Git status: ${errorMessage(error)}`);
    return null;
  });
  const repository = await manager.repoInfo().catch((error) => {
    warnings.push(`Could not read GitHub repository metadata: ${errorMessage(error)}`);
    return null;
  });

  const head = status?.branch ?? "";
  if (!head) {
    warnings.push("Current branch could not be detected. Enter the head branch manually.");
  }

  const base = repository?.default_branch ?? inferBaseFromUpstream(status?.upstream) ?? "main";
  let compare: PRTemplateCompare = {
    base,
    head,
    aheadBy: 0,
    headSha: null,
    commits: [],
    files: [],
  };

  if (base && head && base !== head) {
    compare = await readCompareSummary({ git, manager, base, head, warnings });
  } else if (head && base === head) {
    warnings.push("The current branch matches the base branch. Choose a feature branch before creating a PR.");
  }

  if (compare.headSha) {
    const ciStatus = await manager.getCommitChecks(compare.headSha).catch((error) => {
      warnings.push(`Could not read head CI status: ${errorMessage(error)}`);
      return null;
    });
    if (ciStatus) {
      compare = { ...compare, ciStatus };
    }
  }

  return {
    repository,
    currentBranch: head || null,
    suggestedBase: base,
    base,
    head,
    title: suggestPRTitle(head, compare.commits),
    body: suggestPRBody(compare),
    draft: false,
    compare,
    warnings,
  };
}

async function readCompareSummary({
  git,
  manager,
  base,
  head,
  warnings,
}: {
  git: GitManager;
  manager: GitHubManager;
  base: string;
  head: string;
  warnings: string[];
}): Promise<PRTemplateCompare> {
  try {
    const compare = await manager.compareBranches(base, head);
    return {
      base,
      head,
      aheadBy: compare.aheadBy,
      headSha: compare.headSha,
      commits: compare.commits,
      files: compare.files,
    };
  } catch (error) {
    warnings.push(`Could not compare pushed GitHub branches: ${errorMessage(error)}`);
  }

  for (const ref of [base, `origin/${base}`]) {
    try {
      return fromLocalCompare(base, head, await git.compareWithBase(ref));
    } catch (error) {
      if (ref === `origin/${base}`) {
        warnings.push(`Could not compare local branch with ${base}: ${errorMessage(error)}`);
      }
    }
  }

  return { base, head, aheadBy: 0, headSha: null, commits: [], files: [] };
}

function fromLocalCompare(base: string, head: string, compare: GitCompareSummary): PRTemplateCompare {
  return {
    base,
    head,
    aheadBy: compare.aheadBy,
    headSha: compare.headSha,
    commits: compare.commits,
    files: compare.files,
  };
}

function inferBaseFromUpstream(upstream: string | undefined): string | undefined {
  if (!upstream) return undefined;
  return upstream.replace(/^origin\//, "") || undefined;
}

function suggestPRTitle(head: string, commits: Array<{ message: string }>): string {
  const latest = commits.at(-1)?.message.trim();
  if (latest) return latest;
  return branchTitle(head);
}

function branchTitle(head: string): string {
  const leaf = head.split("/").filter(Boolean).at(-1) ?? head;
  return leaf
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

function suggestPRBody(compare: PRTemplateCompare): string {
  const lines: string[] = [];
  if (compare.commits.length > 0) {
    lines.push("## Commits");
    for (const commit of compare.commits.slice(-10)) {
      lines.push(`- ${commit.message}`);
    }
  }

  if (compare.files.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("## Changed files");
    for (const file of compare.files.slice(0, 20)) {
      lines.push(`- ${file.status} ${file.path}`);
    }
    if (compare.files.length > 20) {
      lines.push(`- ${compare.files.length - 20} more files`);
    }
  }

  return lines.join("\n");
}

export const githubRoutes: Route[] = [
  // --- Token management ---

  route("GET", "/api/github/token", async ({ response, configStore }) => {
    const config = await configStore.load();
    const token = configStore.getGithubToken(config);
    const selectedRepository = getSelectedGitRepository(config);
    const cliAccounts = await new GitHubCliAuth().listAccounts();
    const selected = selectedRepository?.githubCredential;
    const base = {
      ok: true,
      configured: !!token || selected?.source === "gh",
      storedConfigured: !!token,
      deviceFlowAvailable: !!getClientId(),
      accounts: cliAccounts.accounts,
      cliAvailable: cliAccounts.available,
      cliError: cliAccounts.error,
      selected,
      repositoryName: selectedRepository?.name,
    };

    if (!selectedRepository && !token) {
      sendJson(response, { ...base, status: "not_configured" });
      return;
    }

    // The account behind the connection, resolved without an API call whenever
    // possible: a stored token remembers who it belongs to from connect time,
    // and a `gh` credential already names its login (avatars are public).
    let profile = configStore.getGithubProfile(config);
    if (!profile && token) {
      // Backfill for tokens stored before identity was captured, so existing
      // installs pick up an avatar on their next status check instead of
      // needing a reconnect.
      profile = await fetchGitHubProfile(token);
      if (profile) await configStore.setGithubProfile("github.com", profile);
    }

    try {
      if (selectedRepository) {
        const context = await requireGitHubContext(configStore, selectedRepository.path);
        const login =
          context.credential?.source === "gh" ? context.credential.login : profile?.login;
        const user = login
          ? {
              login,
              avatarUrl:
                login === profile?.login && profile.avatarUrl
                  ? profile.avatarUrl
                  : avatarForLogin(login),
            }
          : undefined;
        const repositorySlug = `${context.owner}/${context.repo}`;

        let repository: Awaited<ReturnType<typeof context.manager.repoInfo>>;
        try {
          repository = await context.manager.repoInfo();
        } catch (error) {
          // A 404 here is the credential working perfectly and answering "no
          // such repository for you" — the signed-in account simply can't see
          // this one. Reporting that as a failed connection sent people off to
          // reconnect an account that was never broken.
          if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
          sendJson(response, {
            ...base,
            configured: true,
            status: "repo_access",
            credential: context.credential,
            repositorySlug,
            user,
            error: errorMessage(error),
          });
          return;
        }

        sendJson(response, {
          ...base,
          configured: true,
          status: "connected",
          credential: context.credential,
          repository,
          repositorySlug,
          user,
        });
        return;
      }

      if (!token) throw new Error("No stored GitHub token configured.");
      let account = profile;
      if (!account) {
        const viewer = await new GitHubManager(token, "", "").viewer();
        account = { login: viewer.login, avatarUrl: viewer.avatar_url };
      }
      sendJson(response, {
        ...base,
        status: "connected",
        user: {
          login: account.login,
          avatarUrl: account.avatarUrl ?? avatarForLogin(account.login),
        },
      });
    } catch (error) {
      const status =
        error instanceof GitHubApiError && (error.status === 401 || error.status === 403)
          ? "auth_error"
          : "connection_error";
      sendJson(response, { ...base, status, error: errorMessage(error) });
    }
  }),

  route("GET", "/api/github/accounts", async ({ response }) => {
    const result = await new GitHubCliAuth().listAccounts();
    sendJson(response, { ok: true, ...result });
  }),

  route("PUT", "/api/github/account", async ({ request, response, configStore }) => {
    try {
      const body = await readJson(request);
      const repository = typeof body.repository === "string" ? body.repository.trim() : "";
      const candidate = body.credential;
      if (!repository || !candidate || typeof candidate !== "object") {
        throw new Error("repository and credential are required");
      }
      const value = candidate as Record<string, unknown>;
      const host = typeof value.host === "string" ? value.host.trim() : "";
      if (host && host !== "github.com") {
        throw new Error("The selected repository uses github.com; choose a github.com account.");
      }
      let credential: GitHubCredentialSelection;
      if (value.source === "gh") {
        const login = typeof value.login === "string" ? value.login.trim() : "";
        if (!host || !login) throw new Error("GitHub CLI host and login are required");
        await new GitHubCliAuth().token(host, login);
        credential = { source: "gh", host, login };
      } else if (value.source === "stored") {
        const config = await configStore.load();
        if (!host || !configStore.getGithubToken(config, host)) {
          throw new Error(`No stored GitHub token configured for ${host || "that host"}.`);
        }
        credential = { source: "stored", host };
      } else {
        throw new Error("Unsupported GitHub credential source");
      }
      await configStore.setGitHubCredential(repository, credential);
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/github/token", async ({ request, response, configStore }) => {
    try {
      const form = await readForm(request);
      const host = form.get("host")?.trim() || "github.com";
      const token = requiredFormValue(form, "token");
      await configStore.setGithubToken(host, token, await fetchGitHubProfile(token));
      const config = await configStore.load();
      const selectedRepository = getSelectedGitRepository(config);
      if (selectedRepository) {
        await configStore.setGitHubCredential(selectedRepository.name, { source: "stored", host });
      }
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/github\/token\/([^/]+)$/,
    ["host"],
    async ({ request, response, configStore, params }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      await configStore.removeGithubToken(decodeURIComponent(params.host));
      sendJson(response, { ok: true });
    },
  ),

  // --- OAuth Device Flow ---

  route("POST", "/api/github/oauth/start", async ({ response }) => {
    const clientId = getClientId();
    if (!clientId) {
      sendJson(response, { ok: false, error: "NOMOREIDE_GITHUB_CLIENT_ID is not set." }, 400);
      return;
    }
    try {
      const res = await fetch(`${githubOAuthBase()}${DEVICE_CODE_PATH}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: GITHUB_SCOPES }),
      });
      const data = await res.json() as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        verification_uri_complete?: string;
        expires_in?: number;
        interval?: number;
        error?: string;
        error_description?: string;
      };
      if (data.error) {
        sendJson(response, { ok: false, error: data.error_description ?? data.error }, 400);
        return;
      }
      sendJson(response, {
        ok: true,
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        verification_uri_complete: data.verification_uri_complete ?? data.verification_uri,
        expires_in: data.expires_in ?? 900,
        interval: data.interval ?? 5,
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("POST", "/api/github/oauth/poll", async ({ request, response, configStore }) => {
    const clientId = getClientId();
    if (!clientId) {
      sendJson(response, { ok: false, error: "NOMOREIDE_GITHUB_CLIENT_ID is not set." }, 400);
      return;
    }
    try {
      const body = await readJson(request);
      const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
      if (!deviceCode) {
        sendJson(response, { ok: false, error: "device_code is required" }, 400);
        return;
      }
      const res = await fetch(`${githubOAuthBase()}${ACCESS_TOKEN_PATH}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const data = await res.json() as {
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };
      if (data.access_token) {
        await configStore.setGithubToken(
          "github.com",
          data.access_token,
          await fetchGitHubProfile(data.access_token),
        );
        const config = await configStore.load();
        const selectedRepository = getSelectedGitRepository(config);
        if (selectedRepository) {
          await configStore.setGitHubCredential(selectedRepository.name, {
            source: "stored",
            host: "github.com",
          });
        }
        sendJson(response, { ok: true, done: true });
        return;
      }
      // authorization_pending and slow_down are expected — not errors
      const pending = data.error === "authorization_pending" || data.error === "slow_down";
      if (pending) {
        sendJson(response, { ok: true, done: false, slowDown: data.error === "slow_down" });
        return;
      }
      sendJson(response, {
        ok: false,
        error: data.error_description ?? data.error ?? "Authorization failed",
      }, 400);
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("GET", "/api/github/branches", async ({ response, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const [repository, branches, status] = await Promise.all([
        manager.repoInfo(),
        manager.listBranches(),
        new GitManager(gitCwd).status().catch(() => null),
      ]);
      sendJson(response, {
        ok: true,
        repository,
        defaultBranch: repository.default_branch ?? null,
        currentBranch: status?.branch || null,
        branches,
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  // --- Pull Requests ---

  route("GET", "/api/github/prs", async ({ response, url, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const state = (url.searchParams.get("state") || "open") as "open" | "closed" | "all";
      const page = Number(url.searchParams.get("page")) || 1;
      const prs = await manager.listPRs(state, page);
      sendJson(response, { ok: true, prs });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/github/pr-template", async ({ response, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const template = await buildPRTemplate(gitCwd, manager);
      sendJson(response, { ok: true, template });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/github/prs", async ({ request, response, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const body = await readJson(request);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const head = typeof body.head === "string" ? body.head.trim() : "";
      const base = typeof body.base === "string" ? body.base.trim() : "";
      if (!title || !head || !base) {
        sendJson(response, { ok: false, error: "title, head, and base are required" }, 400);
        return;
      }
      const pr = await manager.createPR({
        title,
        body: typeof body.body === "string" ? body.body : undefined,
        head,
        base,
        draft: body.draft === true,
      });
      sendJson(response, { ok: true, pr });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/github\/prs\/(\d+)$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const pr = await manager.getPR(Number(params.number));
        sendJson(response, { ok: true, pr });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/github\/prs\/(\d+)\/merge$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
        const requested = typeof body.method === "string" ? body.method : "squash";
        const method = (["merge", "squash", "rebase"].includes(requested)
          ? requested
          : "squash") as "merge" | "squash" | "rebase";
        const result = await manager.mergePR(Number(params.number), {
          method,
          commitTitle: typeof body.commitTitle === "string" ? body.commitTitle : undefined,
          commitMessage: typeof body.commitMessage === "string" ? body.commitMessage : undefined,
        });
        sendJson(response, { ok: true, ...result });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/github\/prs\/(\d+)\/review$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const number = Number(params.number);
        const pr = await manager.getPR(number);
        const [files, reviews, comments, checks] = await Promise.all([
          manager.listPRFiles(number),
          manager.listPRReviews(number),
          manager.listIssueComments(number),
          manager.getCommitChecks(pr.head.sha),
        ]);
        sendJson(response, {
          ok: true,
          cockpit: { pr, files, reviews, comments, checks },
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/github\/prs\/(\d+)\/diff$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const diff = await manager.getPRDiff(Number(params.number));
        sendText(response, diff);
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  // --- Issues ---

  route("GET", "/api/github/issues", async ({ response, url, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const state = (url.searchParams.get("state") || "open") as "open" | "closed" | "all";
      const page = Number(url.searchParams.get("page")) || 1;
      const issues = await manager.listIssues(state, page);
      sendJson(response, { ok: true, issues });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/github/issues", async ({ request, response, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const body = await readJson(request);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        sendJson(response, { ok: false, error: "title is required" }, 400);
        return;
      }
      const issue = await manager.createIssue({
        title,
        body: typeof body.body === "string" ? body.body : undefined,
      });
      sendJson(response, { ok: true, issue });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/github\/issues\/(\d+)$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const issue = await manager.getIssue(Number(params.number));
        sendJson(response, { ok: true, issue });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/github\/issues\/(\d+)\/comments$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const number = Number(params.number);

      if (request.method === "GET") {
        try {
          const { manager } = await requireGitHubContext(configStore, gitCwd);
          const comments = await manager.listIssueComments(number);
          sendJson(response, { ok: true, comments });
        } catch (error) {
          sendJson(response, { ok: false, error: errorMessage(error) }, 400);
        }
        return;
      }

      if (request.method === "POST") {
        try {
          const { manager } = await requireGitHubContext(configStore, gitCwd);
          const body = await readJson(request);
          const text = typeof body.body === "string" ? body.body.trim() : "";
          if (!text) {
            sendJson(response, { ok: false, error: "body is required" }, 400);
            return;
          }
          const comment = await manager.addIssueComment(number, text);
          sendJson(response, { ok: true, comment });
        } catch (error) {
          sendJson(response, { ok: false, error: errorMessage(error) }, 400);
        }
        return;
      }

      sendJson(response, { ok: false, error: "Method not allowed" }, 405);
    },
  ),

  // --- CI / Actions ---

  patternRoute(
    /^\/api\/github\/ci\/([0-9a-f]{4,64})$/,
    ["sha"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const ctx = await optionalGitHubContext(configStore, gitCwd);
        if (!ctx) {
          sendJson(response, { ok: true, status: { sha: params.sha, state: "unknown", totalCount: 0, runs: [] } });
          return;
        }
        const status = await ctx.manager.getCommitChecks(params.sha);
        sendJson(response, { ok: true, status });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  route("GET", "/api/github/runs", async ({ response, url, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const branch = url.searchParams.get("branch") || undefined;
      const page = Number(url.searchParams.get("page")) || 1;
      const runs = await manager.listWorkflowRuns(branch, page);
      sendJson(response, { ok: true, runs });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/github\/runs\/(\d+)\/jobs$/,
    ["runId"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const jobs = await manager.listWorkflowRunJobs(Number(params.runId));
        sendJson(response, { ok: true, jobs });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),
];
