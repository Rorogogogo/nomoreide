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
