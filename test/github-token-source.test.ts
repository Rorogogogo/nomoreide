import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The connection-status type lives in the seam's API contract module after the
// transport-seam refactor (the `github.ts` barrel only re-exports it).
const apiSource = readFileSync("apps/dashboard/src/lib/api/github-api.ts", "utf8");
const hookSource = readFileSync(
  "apps/dashboard/src/features/github/hooks/use-github-token.ts",
  "utf8",
);
const indicatorSource = readFileSync(
  "apps/dashboard/src/features/github/github-header-indicator.tsx",
  "utf8",
);
// The <img> itself moved here so the header and the account menu render the
// same avatar with the same offline fallback.
const avatarSource = readFileSync(
  "apps/dashboard/src/features/github/github-avatar.tsx",
  "utf8",
);
const selectorSource = readFileSync(
  "apps/dashboard/src/features/github/github-account-selector.tsx",
  "utf8",
);
// The rows themselves live here, shared by the header indicator (the everyday
// entry point) and the selector on the connection-recovery screen.
const menuSource = readFileSync(
  "apps/dashboard/src/features/github/github-account-menu.tsx",
  "utf8",
);
// Its state and API calls, split out to keep the component near the file budget.
const menuHookSource = readFileSync(
  "apps/dashboard/src/features/github/hooks/use-github-account-menu.ts",
  "utf8",
);

describe("GitHub token client status", () => {
  test("types expose explicit connection states", () => {
    expect(apiSource).toContain("export type GitHubConnectionStatus");
    expect(apiSource).toContain('"not_configured"');
    expect(apiSource).toContain('"connected"');
    expect(apiSource).toContain('"auth_error"');
    expect(apiSource).toContain('"connection_error"');
  });

  test("the connected account carries an avatar for the header indicator", () => {
    expect(apiSource).toContain("user?: { login: string; avatarUrl?: string }");
    // The server half — that the profile is cached at connect time, so a
    // status check costs no extra GitHub API call — is asserted against real
    // responses by `check-github-connection-parity`, not by grepping a source
    // file for an identifier.
    expect(indicatorSource).toContain("user.avatarUrl");
    // Offline dashboards must not render a broken-image glyph.
    expect(avatarSource).toContain("onError");
    expect(avatarSource).toContain('referrerPolicy="no-referrer"');
  });

  test("the account menu shows a face per account, not a generic icon", () => {
    // `gh` reports logins only, so the menu uses the tokenless public avatar
    // route; anything but github.com has no such route and keeps the icon.
    expect(avatarSource).toContain("export function githubAvatarUrl");
    expect(avatarSource).toContain('if (host !== "github.com") return undefined;');
    expect(menuSource).toContain("githubAvatarUrl(account.host, account.login)");
  });

  test("a repo the account can't see is not reported as a broken connection", () => {
    // GitHub answers 404 for private repos the credential can't see, which is
    // the credential working — reporting it as "connection failed / Not Found"
    // read as "you are logged out" and sent people to reconnect.
    expect(apiSource).toContain('"repo_access"');
    // The remote names the repo even when the API refuses to describe it.
    expect(apiSource).toContain("repositorySlug?: string");
  });

  test("repo_access renders its own notice, not the failure card", () => {
    const viewSource = readFileSync(
      "apps/dashboard/src/features/github/github-view.tsx",
      "utf8",
    );
    const noticeSource = readFileSync(
      "apps/dashboard/src/features/github/github-repo-access.tsx",
      "utf8",
    );
    expect(viewSource).toContain('token.status === "repo_access"');
    expect(viewSource).toContain("GitHubRepoAccessNotice");
    // Switching account is the fix, so the picker ships inside the notice.
    expect(noticeSource).toContain("GitHubAccountSelector");
    expect(noticeSource).toContain("github.repoAccess.title");
  });

  test("the account menu can add a token and remove the one it stored", () => {
    const setupSource = readFileSync(
      "apps/dashboard/src/features/github/github-token-setup.tsx",
      "utf8",
    );
    // Reachable only from the setup/failure screens before, which never appear
    // while a `gh` account works.
    expect(menuSource).toContain("onAddToken");
    expect(menuSource).toContain("github.accounts.addToken");
    // The stored-token row is the only thing disconnect removes; say so.
    expect(menuSource).toContain("github.accounts.removeToken");
    // Opening the flow over a working connection must have a way back out.
    expect(setupSource).toContain("onCancel");
    expect(setupSource).toContain("onBack={onCancel ??");
  });

  test("the account menu lives in the header, not the GitHub page's tab row", () => {
    const viewSource = readFileSync(
      "apps/dashboard/src/features/github/github-view.tsx",
      "utf8",
    );
    // The credential is stored per repository, so identity belongs beside the
    // project crumb — and switching account or adding a token must not require
    // navigating to the GitHub page first.
    expect(indicatorSource).toContain("GitHubAccountMenu");
    expect(indicatorSource).toContain("useGitHubAccountMenu");
    expect(indicatorSource).toContain('align: "end"');
    // Removing a stored token — the only sign-out we own — from the header too.
    expect(menuHookSource).toContain("removeGitHubToken");
    // The header trigger keeps its old click action as a menu row.
    expect(indicatorSource).toContain("onOpenGitHub");
    expect(menuSource).toContain("github.accounts.openPage");
    // Only the recovery screen still renders its own trigger.
    expect(viewSource).not.toContain("onAddToken=");
    expect(viewSource.match(/GitHubAccountSelector/g) ?? []).toHaveLength(2);
  });

  test("adding a token from the header survives the page not being mounted", () => {
    const navigationSource = readFileSync(
      "apps/dashboard/src/features/github/github-navigation.ts",
      "utf8",
    );
    // The menu raises the request *while* navigating, so a plain event would
    // fire before the GitHub view subscribes to it.
    expect(navigationSource).toContain("export function requestGitHubTokenSetup");
    expect(navigationSource).toContain("export function consumeGitHubTokenSetupRequest");
    // Both ways in are carried through, so the menu's two rows land on two
    // different screens rather than both dropping the user on the PAT form.
    expect(indicatorSource).toContain('requestGitHubTokenSetup("pat")');
    expect(indicatorSource).toContain('requestGitHubTokenSetup("device-pending")');
  });

  test("the menu says how to add an account, and carries no sign-out section", () => {
    // "Add a personal access token" was the only way in, which reads as the
    // only way to add an account — the browser sign-in existed but was buried
    // in the setup screens, and gh accounts looked unaddable.
    expect(menuSource).toContain("github.accounts.signIn");
    expect(menuSource).toContain("info.deviceFlowAvailable");
    // A `gh` account can only be added by `gh` itself, so the command is handed
    // over (copyable) rather than hidden or faked.
    expect(menuSource).toContain('command="gh auth login"');
    // Sign-out was only ever asked for as a way to add another account, which
    // the section above now does directly. What is left — a `gh auth logout`
    // explainer for a credential we do not own — was menu weight for nothing.
    expect(menuSource).not.toContain("gh auth logout");
    expect(menuSource).not.toContain("signOutSection");
    // Removing our own stored token survives, docked to the row it acts on.
    const storedIndex = menuSource.indexOf("github.accounts.nomoreideToken");
    const removeIndex = menuSource.indexOf("github.accounts.removeToken");
    expect(storedIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(storedIndex);
    expect(menuSource.slice(storedIndex, removeIndex)).not.toContain("MenuSectionLabel");
  });

  test("hook exposes status, error, and refresh", () => {
    expect(hookSource).toContain("status");
    expect(hookSource).toContain("error");
    expect(hookSource).toContain("refresh");
    expect(hookSource).toContain("isConnected");
  });

  test("token state is shared, so switching account updates every consumer", () => {
    // Per-component `useState` here meant the header kept a stale avatar until
    // a full page reload after switching account from the GitHub view.
    expect(hookSource).toContain("useSyncExternalStore");
    expect(hookSource).toContain("export function refreshGitHubToken");
    expect(hookSource).toContain("const listeners = new Set<() => void>();");
    // Out-of-order responses must not resurrect the account we just left.
    expect(hookSource).toContain("if (id !== requestId) return;");
  });
});
