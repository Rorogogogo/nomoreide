import { describe, expect, test, vi, afterEach } from "vitest";
import { GitHubManager, GitHubApiError } from "../src/core/github-manager.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: { ok: boolean; status?: number; body: unknown; text?: string }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    statusText: response.ok ? "OK" : "Bad Request",
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(response.text ?? JSON.stringify(response.body)),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
