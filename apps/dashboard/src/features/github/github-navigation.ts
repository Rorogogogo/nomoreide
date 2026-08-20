const ACTIONS_INTENT_EVENT = "nomoreide:open-github-actions";
const TAB_STORAGE_KEY = "nomoreide:github:tab";
const BRANCH_STORAGE_KEY = "nomoreide:github:actions-branch";

export interface GitHubActionsIntent {
  branch: string | null;
}

/** Persist a deep link for an unmounted GitHub view and notify a mounted one. */
export function requestGitHubActions(branch?: string): void {
  const intent: GitHubActionsIntent = { branch: branch ?? null };
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify("actions"));
    window.localStorage.setItem(BRANCH_STORAGE_KEY, JSON.stringify(intent.branch));
  } catch {
    // Storage can be unavailable in private mode; the event still handles a
    // GitHub view that is already mounted.
  }
  window.dispatchEvent(new CustomEvent<GitHubActionsIntent>(ACTIONS_INTENT_EVENT, {
    detail: intent,
  }));
}

export function subscribeToGitHubActions(
  listener: (intent: GitHubActionsIntent) => void,
): () => void {
  const handle = (event: Event) => {
    listener((event as CustomEvent<GitHubActionsIntent>).detail);
  };
  window.addEventListener(ACTIONS_INTENT_EVENT, handle);
  return () => window.removeEventListener(ACTIONS_INTENT_EVENT, handle);
}

const TOKEN_SETUP_EVENT = "nomoreide:open-github-token-setup";

/** Which way in: GitHub's browser authorization, or pasting a token. */
export type GitHubSetupMode = "device-pending" | "pat";

let tokenSetupPending: GitHubSetupMode | null = null;

/**
 * Ask the GitHub view to open a sign-in flow. Latched rather than
 * fire-and-forget: the header's account menu raises this *while* it navigates
 * to the page, so the view is usually still unmounted when it fires.
 */
export function requestGitHubTokenSetup(mode: GitHubSetupMode): void {
  tokenSetupPending = mode;
  window.dispatchEvent(new Event(TOKEN_SETUP_EVENT));
}

/** Reads and clears a pending request — call on mount and on the event. */
export function consumeGitHubTokenSetupRequest(): GitHubSetupMode | null {
  const pending = tokenSetupPending;
  tokenSetupPending = null;
  return pending;
}

export function subscribeToGitHubTokenSetup(listener: () => void): () => void {
  window.addEventListener(TOKEN_SETUP_EVENT, listener);
  return () => window.removeEventListener(TOKEN_SETUP_EVENT, listener);
}
