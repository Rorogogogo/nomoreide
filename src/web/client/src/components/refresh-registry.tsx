import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

export interface RefreshOptions {
  manual: boolean;
}

type RefreshHandler = (options: RefreshOptions) => void | Promise<void>;

export interface RefreshRegistry {
  /** A page registers how it reloads its own data; returns an unregister fn. */
  register: (handler: RefreshHandler) => () => void;
  /** Fire every registered handler — in practice, the mounted page's own. */
  runActive: (options?: RefreshOptions) => Promise<void>;
}

const RefreshRegistryContext = createContext<RefreshRegistry | null>(null);

/**
 * App-level fan-out for the header Refresh button. Most pages own data the
 * shared dashboard payload doesn't cover (GitHub PRs/issues/branches/actions,
 * DB connections, the commit graph); each registers a handler here so the one
 * header Refresh also reloads what's actually on screen. Only the mounted
 * page's handler is registered at a time, so `runActive` targets the current
 * view without the header needing to know which page that is.
 */
export function useRefreshRegistry(): RefreshRegistry {
  const handlers = useRef(new Set<RefreshHandler>());
  const register = useCallback((handler: RefreshHandler) => {
    handlers.current.add(handler);
    return () => {
      handlers.current.delete(handler);
    };
  }, []);
  const runActive = useCallback(async (options: RefreshOptions = { manual: false }) => {
    await Promise.all(
      [...handlers.current].map((handler) => Promise.resolve().then(() => handler(options))),
    );
  }, []);
  return { register, runActive };
}

export function RefreshRegistryProvider({
  value,
  children,
}: {
  value: RefreshRegistry;
  children: ReactNode;
}) {
  return (
    <RefreshRegistryContext.Provider value={value}>
      {children}
    </RefreshRegistryContext.Provider>
  );
}

/**
 * Register the current page's data-refresh handler with the header Refresh
 * button. The latest handler is always invoked, so it can close over changing
 * state (e.g. the active GitHub tab) without re-registering on every change.
 */
export function useRegisterRefresh(handler: RefreshHandler) {
  const ctx = useContext(RefreshRegistryContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!ctx) return;
    return ctx.register(() => ref.current());
  }, [ctx]);
}
