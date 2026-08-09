import type { SettingId, SettingsCategoryId } from "@/features/settings/settings-catalogue";

export type GlobalSearchFocusIntent =
  | { type: "setting"; category: SettingsCategoryId; setting: SettingId }
  | { type: "git-file"; path: string };

const FOCUS_EVENT = "nomoreide:global-search-focus";
let pendingFocus: GlobalSearchFocusIntent | null = null;

export function requestGlobalSearchFocus(intent: GlobalSearchFocusIntent): void {
  pendingFocus = intent;
  window.dispatchEvent(new CustomEvent<GlobalSearchFocusIntent>(FOCUS_EVENT, { detail: intent }));
}

export function consumeGlobalSearchFocus<T extends GlobalSearchFocusIntent["type"]>(
  type: T,
): Extract<GlobalSearchFocusIntent, { type: T }> | null {
  if (pendingFocus?.type !== type) return null;
  const intent = pendingFocus as Extract<GlobalSearchFocusIntent, { type: T }>;
  pendingFocus = null;
  return intent;
}

export function subscribeToGlobalSearchFocus(
  type: GlobalSearchFocusIntent["type"],
  listener: (intent: GlobalSearchFocusIntent) => void,
): () => void {
  const handle = (event: Event) => {
    const intent = (event as CustomEvent<GlobalSearchFocusIntent>).detail;
    if (intent.type !== type) return;
    if (pendingFocus === intent) pendingFocus = null;
    listener(intent);
  };
  window.addEventListener(FOCUS_EVENT, handle);
  return () => window.removeEventListener(FOCUS_EVENT, handle);
}
