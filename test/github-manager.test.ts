import { describe, expect, test, vi, afterEach } from "vitest";
import {
  GitHubManager,
  GitHubApiError,
  clearGitHubEtagCache,
} from "../src/core/github-manager.js";

afterEach(() => {
  vi.unstubAllGlobals();
  // The validator cache is module-level by design (a manager is rebuilt per
  // request), so it has to be reset between tests.
  clearGitHubEtagCache();
});

function mockFetch(response: {
  ok: boolean;
  status?: number;
  body: unknown;
  text?: string;
  etag?: string;
}) {
  const fetchMock = vi.fn().mockResolvedValue(buildResponse(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function buildResponse(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
  text?: string;
  etag?: string;
}) {
  return {
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    statusText: response.ok ? "OK" : "Bad Request",
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? response.etag ?? null : null) },
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(response.text ?? JSON.stringify(response.body)),
  };
}

describe("GitHubManager.parseRemoteUrl", () => {
  test("parses https GitHub URL", () => {
    expect(GitHubManager.parseRemoteUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses https GitHub URL without .git suffix", () => {
    expect(GitHubManager.parseRemoteUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses SSH GitHub URL", () => {
    expect(GitHubManager.parseRemoteUrl("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses SSH GitHub URL without .git", () => {
    expect(GitHubManager.parseRemoteUrl("git@github.com:owner/my-repo")).toEqual({
      owner: "owner",
      repo: "my-repo",
    });
  });

  test("returns null for non-GitHub URLs", () => {
    expect(GitHubManager.parseRemoteUrl("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(GitHubManager.parseRemoteUrl("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(GitHubManager.parseRemoteUrl("not-a-url")).toBeNull();
    expect(GitHubManager.parseRemoteUrl("")).toBeNull();
  });

  test("parses https URL with token in it", () => {
    expect(GitHubManager.parseRemoteUrl("https://user:token@github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });
});

describe("GitHubManager API", () => {
  const manager = new GitHubManager("ghp_test_token", "acme", "myrepo");

  test("listPRs returns normalized PR list", async () => {
    const rawPRs = [
      {
        number: 42,
        title: "Fix bug",
        state: "open",
        body: "Details",
        html_url: "https://github.com/acme/myrepo/pull/42",
        head: { ref: "fix-bug", sha: "abc123" },
        base: { ref: "main" },
        user: { login: "dev" },
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        merged_at: null,
        draft: false,
        mergeable: true,
      },
    ];
    mockFetch({ ok: true, body: rawPRs });

    const prs = await manager.listPRs();
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 42, title: "Fix bug", state: "open" });
  });

  test("merged PR has state 'merged'", async () => {
    const rawPRs = [
      {
        number: 1,
        title: "Merged",
        state: "closed",
        body: null,
        html_url: "https://github.com/acme/myrepo/pull/1",
        head: { ref: "feat", sha: "fff" },
        base: { ref: "main" },
        user: { login: "dev" },
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        merged_at: "2024-01-02T00:00:00Z",
        draft: false,
        mergeable: null,
      },
    ];
    mockFetch({ ok: true, body: rawPRs });

    const prs = await manager.listPRs("closed");
    expect(prs[0]?.state).toBe("merged");
  });

  test("sends Authorization header with token", async () => {
    const fetchMock = mockFetch({ ok: true, body: [] });
    await manager.listPRs();
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer ghp_test_token");
  });

  test("listIssues filters out PRs", async () => {
    const rawIssues = [
      {
        number: 1,
        title: "Bug report",
        state: "open",
        body: null,
        html_url: "https://github.com/acme/myrepo/issues/1",
        user: { login: "user" },
        labels: [],
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        comments: 0,
      },
      {
        number: 2,
        title: "A pull request",
        state: "open",
        body: null,
        html_url: "https://github.com/acme/myrepo/pull/2",
        user: { login: "dev" },
        labels: [],
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        comments: 0,
        pull_request: { url: "https://..." },
      },
    ];
    mockFetch({ ok: true, body: rawIssues });

    const issues = await manager.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(1);
  });

  test("getCommitChecks returns unknown state for 404", async () => {
    mockFetch({ ok: false, status: 404, body: { message: "Not Found" } });
    const status = await manager.getCommitChecks("abc1234");
    expect(status.state).toBe("unknown");
    expect(status.totalCount).toBe(0);
  });

  test("getCommitChecks derives success from all-passing runs", async () => {
    mockFetch({
      ok: true,
      body: {
        total_count: 2,
        check_runs: [
          { id: 1, name: "CI", status: "completed", conclusion: "success", html_url: "", started_at: null, completed_at: null },
          { id: 2, name: "Lint", status: "completed", conclusion: "skipped", html_url: "", started_at: null, completed_at: null },
        ],
      },
    });

    const status = await manager.getCommitChecks("abc1234");
    expect(status.state).toBe("success");
    expect(status.totalCount).toBe(2);
  });

  test("getCommitChecks derives failure from failed run", async () => {
    mockFetch({
      ok: true,
      body: {
        total_count: 2,
        check_runs: [
          { id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "", started_at: null, completed_at: null },
          { id: 2, name: "Lint", status: "completed", conclusion: "success", html_url: "", started_at: null, completed_at: null },
        ],
      },
    });

    const status = await manager.getCommitChecks("abc1234");
    expect(status.state).toBe("failure");
  });

  test("getCommitChecks returns pending when check is in_progress", async () => {
    mockFetch({
      ok: true,
      body: {
        total_count: 1,
        check_runs: [
          { id: 1, name: "CI", status: "in_progress", conclusion: null, html_url: "", started_at: null, completed_at: null },
        ],
      },
    });

    const status = await manager.getCommitChecks("abc1234");
    expect(status.state).toBe("pending");
  });

  test("listWorkflowRunJobs returns jobs with steps", async () => {
    const fetchMock = mockFetch({
      ok: true,
      body: {
        total_count: 1,
        jobs: [
          {
            id: 10,
            run_id: 99,
            html_url: "https://github.com/acme/myrepo/actions/runs/99/job/10",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-01T00:00:00Z",
            completed_at: "2026-01-01T00:02:00Z",
            name: "build",
            steps: [
              {
                name: "Checkout",
                status: "completed",
                conclusion: "success",
                number: 1,
                started_at: "2026-01-01T00:00:00Z",
                completed_at: "2026-01-01T00:00:10Z",
              },
            ],
          },
        ],
      },
    });

    const jobs = await manager.listWorkflowRunJobs(99);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 10,
      name: "build",
      steps: [{ name: "Checkout", conclusion: "success" }],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/actions/runs/99/jobs");
  });

  test("repoInfo exposes the repository default branch", async () => {
    mockFetch({
      ok: true,
      body: {
        full_name: "acme/myrepo",
        html_url: "https://github.com/acme/myrepo",
        default_branch: "trunk",
      },
    });

    const info = await manager.repoInfo();

    expect(info.default_branch).toBe("trunk");
  });

  test("compareBranches returns normalized ahead commits and changed files", async () => {
    const fetchMock = mockFetch({
      ok: true,
      body: {
        ahead_by: 2,
        status: "ahead",
        commits: [
          { sha: "abc111", commit: { message: "first change\n\nbody" } },
          { sha: "abc222", commit: { message: "second change" } },
        ],
        files: [
          { filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, changes: 4 },
          { filename: "src/b.ts", status: "added", additions: 8, deletions: 0, changes: 8 },
        ],
      },
    });

    const compare = await manager.compareBranches("main", "feature/work");

    expect(compare).toMatchObject({
      aheadBy: 2,
      status: "ahead",
      commits: [
        { sha: "abc111", message: "first change" },
        { sha: "abc222", message: "second change" },
      ],
      files: [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
        { path: "src/b.ts", status: "added", additions: 8, deletions: 0 },
      ],
      headSha: "abc222",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/compare/main...feature%2Fwork");
  });

  test("listPRFiles returns normalized pull request changed files", async () => {
    const fetchMock = mockFetch({
      ok: true,
      body: [
        {
          filename: "src/review.ts",
          status: "modified",
          additions: 12,
          deletions: 3,
          changes: 15,
          patch: "@@ -1 +1 @@",
          blob_url: "https://github.com/acme/myrepo/blob/abc/src/review.ts",
        },
      ],
    });

    const files = await manager.listPRFiles(42);

    expect(files).toEqual([
      {
        path: "src/review.ts",
        status: "modified",
        additions: 12,
        deletions: 3,
        changes: 15,
        patch: "@@ -1 +1 @@",
        blob_url: "https://github.com/acme/myrepo/blob/abc/src/review.ts",
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/pulls/42/files");
  });

  test("listPRReviews returns review states and reviewers", async () => {
    const fetchMock = mockFetch({
      ok: true,
      body: [
        {
          id: 10,
          state: "APPROVED",
          body: "Looks good",
          user: { login: "reviewer" },
          submitted_at: "2026-06-11T00:00:00Z",
          html_url: "https://github.com/acme/myrepo/pull/42#pullrequestreview-10",
        },
      ],
    });

    const reviews = await manager.listPRReviews(42);

    expect(reviews).toEqual([
      {
        id: 10,
        state: "APPROVED",
        body: "Looks good",
        user: { login: "reviewer" },
        submitted_at: "2026-06-11T00:00:00Z",
        html_url: "https://github.com/acme/myrepo/pull/42#pullrequestreview-10",
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/pulls/42/reviews");
  });

  test("listBranches returns normalized repository branches", async () => {
    const fetchMock = mockFetch({
      ok: true,
      body: [
        {
          name: "main",
          protected: true,
          commit: {
            sha: "abc1234",
            url: "https://api.github.com/repos/acme/myrepo/commits/abc1234",
          },
        },
        {
          name: "feature/work",
          protected: false,
          commit: {
            sha: "def5678",
            url: "https://api.github.com/repos/acme/myrepo/commits/def5678",
          },
        },
      ],
    });

    const branches = await manager.listBranches();

    expect(branches).toEqual([
      { name: "main", protected: true, commit: { sha: "abc1234" } },
      { name: "feature/work", protected: false, commit: { sha: "def5678" } },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/branches?per_page=100");
  });

  test("throws GitHubApiError on non-2xx response", async () => {
    mockFetch({ ok: false, status: 401, body: { message: "Bad credentials" } });
    await expect(manager.listPRs()).rejects.toBeInstanceOf(GitHubApiError);
    await expect(manager.listPRs()).rejects.toMatchObject({ status: 401 });
  });

  test("getPRDiff requests diff media type", async () => {
    const fetchMock = mockFetch({ ok: true, body: {}, text: "diff --git a/foo b/foo\n" });
    await manager.getPRDiff(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.Accept).toBe("application/vnd.github.diff");
  });
});

describe("GitHubManager conditional requests", () => {
  const rawPR = {
    number: 7,
    title: "Cached",
    state: "open",
    body: null,
    html_url: "https://github.com/acme/myrepo/pull/7",
    head: { ref: "feat", sha: "abc" },
    base: { ref: "main" },
    user: { login: "dev" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    merged_at: null,
    draft: false,
    mergeable: null,
  };

  test("replays the cached body when GitHub answers 304", async () => {
    const manager = new GitHubManager("ghp_etag_token", "acme", "myrepo");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ ok: true, body: [rawPR], etag: 'W/"v1"' }))
      .mockResolvedValueOnce(buildResponse({ ok: false, status: 304, text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await manager.listPRs();
    const second = await manager.listPRs();

    expect(first[0]?.number).toBe(7);
    expect(second).toEqual(first);
    // The validator went out on the second call, which is what earns the 304.
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondHeaders["If-None-Match"]).toBe('W/"v1"');
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders["If-None-Match"]).toBeUndefined();
  });

  test("a 304 replay hands out a fresh object each time", async () => {
    const manager = new GitHubManager("ghp_etag_token", "acme", "myrepo");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        buildResponse({ ok: true, body: [{ id: 1, state: "APPROVED" }], etag: 'W/"r1"' }),
      )
      .mockResolvedValue(buildResponse({ ok: false, status: 304, text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await manager.listPRReviews(42);
    first.length = 0; // a caller mutating its own copy must not poison the cache

    const second = await manager.listPRReviews(42);
    expect(second).toHaveLength(1);
  });

  test("a different token never reads another account's cached body", async () => {
    const mine = new GitHubManager("ghp_mine", "acme", "myrepo");
    const theirs = new GitHubManager("ghp_theirs", "acme", "myrepo");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(buildResponse({ ok: true, body: [rawPR], etag: 'W/"v1"' }));
    vi.stubGlobal("fetch", fetchMock);

    await mine.listPRs();
    await theirs.listPRs();

    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondHeaders["If-None-Match"]).toBeUndefined();
  });

  test("writes are never revalidated", async () => {
    const manager = new GitHubManager("ghp_etag_token", "acme", "myrepo");
    const fetchMock = mockFetch({ ok: true, body: rawPR, etag: 'W/"v1"' });

    await manager.createPR({ title: "t", head: "feat", base: "main" });
    await manager.createPR({ title: "t", head: "feat", base: "main" });

    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["If-None-Match"]).toBeUndefined();
    }
  });

  test("a response without an ETag is not cached", async () => {
    const manager = new GitHubManager("ghp_etag_token", "acme", "myrepo");
    const fetchMock = mockFetch({ ok: true, body: [rawPR] });

    await manager.listPRs();
    await manager.listPRs();

    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondHeaders["If-None-Match"]).toBeUndefined();
  });

  test("caches diff text alongside JSON", async () => {
    const manager = new GitHubManager("ghp_etag_token", "acme", "myrepo");
    const diff = "diff --git a/foo b/foo\n";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ ok: true, body: {}, text: diff, etag: 'W/"d1"' }))
      .mockResolvedValueOnce(buildResponse({ ok: false, status: 304, text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await manager.getPRDiff(1)).toBe(diff);
    expect(await manager.getPRDiff(1)).toBe(diff);
  });
});
