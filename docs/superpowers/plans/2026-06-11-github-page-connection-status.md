# GitHub Page Connection Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote GitHub to a top-level page and add explicit connection status, refresh, and relogin recovery.

**Architecture:** Reuse the existing `GitHubView` feature, but move it from `GitReviewView` into the app-level router/sidebar. Extend the existing `/api/github/token` endpoint into a lightweight status probe that validates the configured token. Keep the connect/reconnect UI in the GitHub feature folder so auth recovery remains local to GitHub.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, local REST routes, GitHub REST API via `fetch`.

---

## File Structure

- Modify `src/web/routes/github-routes.ts`: extend `GET /api/github/token` to return `status`, `error`, and optional user/repository metadata.
- Modify `src/core/github-manager.ts`: add a lightweight `viewer()` and `repoInfo()` request method, or expose one status method used by the route.
- Modify `src/web/client/src/lib/api/github.ts`: extend `GitHubTokenInfo` with the new status fields.
- Modify `src/web/client/src/features/github/hooks/use-github-token.ts`: expose status, error, refresh, and helper booleans.
- Modify `src/web/client/src/features/github/github-token-setup.tsx`: support reconnect/PAT mode from the recovery panel.
- Modify `src/web/client/src/features/github/github-view.tsx`: render status banner, recovery panel, and connected content.
- Modify `src/web/client/src/app.tsx`: add `github` to route state, sidebar nav, and route rendering.
- Modify `src/web/client/src/features/git/git-review-view.tsx`: remove the GitHub tab/import while preserving current dirty-worktree board changes.
- Test `test/web-server.test.ts`: cover configured, not configured, auth failure, and connection failure token status.
- Test `test/app-version.test.tsx` or a focused app source test: cover GitHub route/nav source behavior.
- Test `test/github-view-source.test.tsx` or source tests: cover recovery actions and no nested GitHub tab.

---

### Task 1: Server GitHub Token Status

**Files:**
- Modify: `src/core/github-manager.ts`
- Modify: `src/web/routes/github-routes.ts`
- Test: `test/web-server.test.ts`

- [ ] **Step 1: Write failing server tests**

Add tests near the existing GitHub token tests in `test/web-server.test.ts`:

```ts
test("reports configured GitHub token as connected when validation succeeds", async () => {
  const realFetch = globalThis.fetch;
  const fetchMock = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) === "https://api.github.com/user") {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer good-token" });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ login: "octocat" }),
      } as Response);
    }
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  const configPath = join(tempDir, "nomoreide.config.json");
  const config = new ConfigStore(configPath);
  await config.setGithubToken("github.com", "good-token");
  server = await createWebServer({ configPath, logDir: join(tempDir, "logs"), cwd: tempDir, port: 0 }).start();

  const response = await fetch(`${server.url}/api/github/token`);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    configured: true,
    status: "connected",
    user: { login: "octocat" },
  });
});

test("reports configured GitHub token auth failure", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    json: () => Promise.resolve({ message: "Bad credentials" }),
  } as Response)));
  const configPath = join(tempDir, "nomoreide.config.json");
  const config = new ConfigStore(configPath);
  await config.setGithubToken("github.com", "bad-token");
  server = await createWebServer({ configPath, logDir: join(tempDir, "logs"), cwd: tempDir, port: 0 }).start();

  const response = await fetch(`${server.url}/api/github/token`);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    configured: true,
    status: "auth_error",
    error: "Bad credentials",
  });
});

test("reports configured GitHub token connection failure", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
  const configPath = join(tempDir, "nomoreide.config.json");
  const config = new ConfigStore(configPath);
  await config.setGithubToken("github.com", "token");
  server = await createWebServer({ configPath, logDir: join(tempDir, "logs"), cwd: tempDir, port: 0 }).start();

  const response = await fetch(`${server.url}/api/github/token`);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    configured: true,
    status: "connection_error",
    error: "network down",
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/web-server.test.ts --testNamePattern "GitHub token"`

Expected: FAIL because `/api/github/token` does not return `status`, `user`, or validation errors.

- [ ] **Step 3: Add lightweight GitHub validation**

In `src/core/github-manager.ts`, add:

```ts
export interface GitHubViewer {
  login: string;
}

export interface GitHubRepoInfo {
  full_name: string;
  html_url: string;
}

async viewer(): Promise<GitHubViewer> {
  return this.request<GitHubViewer>("/user");
}

async repoInfo(): Promise<GitHubRepoInfo> {
  return this.request<GitHubRepoInfo>(`/repos/${this.owner}/${this.repo}`);
}
```

In `src/web/routes/github-routes.ts`, extend `GET /api/github/token`:

```ts
const config = await configStore.load();
const token = configStore.getGithubToken(config);
const base = { ok: true, configured: !!token, deviceFlowAvailable: !!getClientId() };
if (!token) {
  sendJson(response, { ...base, status: "not_configured" });
  return;
}
try {
  const gitCwd = await selectedGitCwd(configStore, cwd).catch(() => "");
  if (gitCwd) {
    const context = await optionalGitHubContext(configStore, gitCwd);
    if (context) {
      const repository = await context.manager.repoInfo();
      sendJson(response, { ...base, status: "connected", repository });
      return;
    }
  }
  const viewer = await new GitHubManager(token, "", "").viewer();
  sendJson(response, { ...base, status: "connected", user: viewer });
} catch (error) {
  const status = error instanceof GitHubApiError && (error.status === 401 || error.status === 403)
    ? "auth_error"
    : "connection_error";
  sendJson(response, { ...base, status, error: errorMessage(error) });
}
```

Also import `GitHubApiError` and `GitHubManager`.

- [ ] **Step 4: Run server tests**

Run: `npx vitest run test/web-server.test.ts --testNamePattern "GitHub token"`

Expected: PASS.

---

### Task 2: Client API and Token Hook

**Files:**
- Modify: `src/web/client/src/lib/api/github.ts`
- Modify: `src/web/client/src/features/github/hooks/use-github-token.ts`
- Test: `test/github-token-source.test.ts`

- [ ] **Step 1: Add source-level tests**

Create `test/github-token-source.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const apiSource = readFileSync("src/web/client/src/lib/api/github.ts", "utf8");
const hookSource = readFileSync("src/web/client/src/features/github/hooks/use-github-token.ts", "utf8");

describe("GitHub token client status", () => {
  test("types expose explicit connection states", () => {
    expect(apiSource).toContain('export type GitHubConnectionStatus');
    expect(apiSource).toContain('"not_configured"');
    expect(apiSource).toContain('"connected"');
    expect(apiSource).toContain('"auth_error"');
    expect(apiSource).toContain('"connection_error"');
  });

  test("hook exposes status, error, and refresh", () => {
    expect(hookSource).toContain("status");
    expect(hookSource).toContain("error");
    expect(hookSource).toContain("refresh");
    expect(hookSource).toContain("isConnected");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/github-token-source.test.ts`

Expected: FAIL because the type and hook fields do not exist yet.

- [ ] **Step 3: Extend API types and hook**

In `src/web/client/src/lib/api/github.ts`, replace `GitHubTokenInfo` with:

```ts
export type GitHubConnectionStatus =
  | "checking"
  | "not_configured"
  | "connected"
  | "auth_error"
  | "connection_error";

export interface GitHubTokenInfo {
  configured: boolean;
  deviceFlowAvailable: boolean;
  status: Exclude<GitHubConnectionStatus, "checking">;
  error?: string;
  user?: { login: string };
  repository?: { full_name: string; html_url: string };
}
```

In `src/web/client/src/features/github/hooks/use-github-token.ts`, return:

```ts
return {
  configured,
  deviceFlowAvailable,
  loading,
  status,
  error,
  info,
  isConnected: status === "connected",
  needsLogin: status === "not_configured" || status === "auth_error",
  refresh,
};
```

- [ ] **Step 4: Run client token tests**

Run: `npx vitest run test/github-token-source.test.ts`

Expected: PASS.

---

### Task 3: Top-Level GitHub Navigation

**Files:**
- Modify: `src/web/client/src/app.tsx`
- Modify: `src/web/client/src/features/git/git-review-view.tsx`
- Test: `test/github-navigation-source.test.ts`

- [ ] **Step 1: Add source-level navigation tests**

Create `test/github-navigation-source.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const appSource = readFileSync("src/web/client/src/app.tsx", "utf8");
const gitReviewSource = readFileSync("src/web/client/src/features/git/git-review-view.tsx", "utf8");

describe("GitHub top-level navigation", () => {
  test("app owns the GitHub page route", () => {
    expect(appSource).toContain('| "github"');
    expect(appSource).toContain('startsWith("/github")');
    expect(appSource).toContain('page === "github"');
    expect(appSource).toContain("<GitHubView");
  });

  test("git review no longer embeds GitHub as a tab", () => {
    expect(gitReviewSource).not.toContain('| "github"');
    expect(gitReviewSource).not.toContain("GitHubView");
    expect(gitReviewSource).not.toContain("GitHubLogo");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/github-navigation-source.test.ts`

Expected: FAIL because the app route is missing and the Git review tab still imports/renders GitHub.

- [ ] **Step 3: Add app-level GitHub page**

In `src/web/client/src/app.tsx`:

- Import `Github` icon or reuse `GitHubLogo`.
- Import `GitHubView`.
- Add `"github"` to `Page`.
- Map `/github` in initial route and history sync.
- Add a sidebar button labeled `GitHub`.
- Render `<GitHubView />` when `page === "github"`.

Patch `src/web/client/src/features/git/git-review-view.tsx` to remove the GitHub tab type, import, tab button, and render branch. Keep current `Board`, `Snapshots`, and `Workflows` edits intact.

- [ ] **Step 4: Run navigation tests**

Run: `npx vitest run test/github-navigation-source.test.ts`

Expected: PASS.

---

### Task 4: GitHub Recovery UI

**Files:**
- Modify: `src/web/client/src/features/github/github-token-setup.tsx`
- Modify: `src/web/client/src/features/github/github-view.tsx`
- Test: `test/github-view-source.test.ts`

- [ ] **Step 1: Add source-level recovery tests**

Create `test/github-view-source.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const viewSource = readFileSync("src/web/client/src/features/github/github-view.tsx", "utf8");
const setupSource = readFileSync("src/web/client/src/features/github/github-token-setup.tsx", "utf8");

describe("GitHub connection recovery UI", () => {
  test("view renders refresh and reconnect recovery paths", () => {
    expect(viewSource).toContain("GitHubConnectionRecovery");
    expect(viewSource).toContain("Reconnect GitHub");
    expect(viewSource).toContain("Refresh");
    expect(viewSource).toContain("Use token instead");
    expect(viewSource).toContain("auth_error");
    expect(viewSource).toContain("connection_error");
  });

  test("setup supports explicit PAT and device-flow starts", () => {
    expect(setupSource).toContain("initialMode");
    expect(setupSource).toContain('"pat"');
    expect(setupSource).toContain('"device-pending"');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/github-view-source.test.ts`

Expected: FAIL because recovery components and setup `initialMode` do not exist.

- [ ] **Step 3: Implement recovery UI**

In `GitHubTokenSetup`, add optional prop:

```ts
initialMode?: SetupMode;
```

Initialize mode with:

```ts
const [mode, setMode] = useState<SetupMode>(
  initialMode ?? (deviceFlowAvailable ? "choose" : "pat"),
);
```

In `GitHubView`, use `useGitHubToken()` fields:

```tsx
if (token.loading || token.status === "checking") return <Loading />;
if (token.status === "not_configured") return <GitHubTokenSetup ... />;
if (token.status === "auth_error" || token.status === "connection_error") {
  return <GitHubConnectionRecovery token={token} />;
}
return <GitHubContent token={token} />;
```

Add `GitHubConnectionRecovery` with buttons for refresh, reconnect, and PAT mode. Reconnect should render `GitHubTokenSetup initialMode="device-pending"` when device flow is available and PAT form otherwise.

- [ ] **Step 4: Run recovery UI tests**

Run: `npx vitest run test/github-view-source.test.ts`

Expected: PASS.

---

### Task 5: Full Verification

**Files:**
- Verify: all changed files

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run test/web-server.test.ts test/github-token-source.test.ts test/github-navigation-source.test.ts test/github-view-source.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Inspect git status**

Run: `git status --short`

Expected: only intended implementation files plus pre-existing unrelated dirty files remain. Do not revert unrelated dirty files.

