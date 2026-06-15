import { useCallback, useState } from "react";

/**
 * Like `useState`, but the value is mirrored to `localStorage` under `key`, so
 * it survives a component unmount (e.g. navigating to another page and back)
 * and a full page reload. Used for sticky UI selections — the active tab/mode
 * of a view — so returning to a page lands on the tab you left, not the default.
 *
 * Keys are namespaced `nomoreide:` to match the rest of the app's storage.
 */
export function usePersistentState<T>(key: string, fallback: T) {
  const storageKey = `nomoreide:${key}`;

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage unavailable (private mode / quota) — keep in-memory state.
      }
    },
    [storageKey],
  );

  return [value, set] as const;
}
