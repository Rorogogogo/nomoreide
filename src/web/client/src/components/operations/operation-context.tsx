import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useToasts } from "@/components/ui/toast";

export interface OperationInput {
  key?: string;
  label: string;
  successMessage?: string;
  errorMessage?: (error: unknown) => string;
}

export interface ActiveOperation {
  id: string;
  key?: string;
  label: string;
  startedAt: number;
}

export interface OperationContextValue {
  operations: ActiveOperation[];
  runOperation<T>(input: OperationInput, action: () => Promise<T>): Promise<T>;
  isPending(key: string): boolean;
}

const OperationContext = createContext<OperationContextValue | null>(null);

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "Unknown error");
}

export function OperationProvider({ children }: { children: ReactNode }) {
  const [operations, setOperations] = useState<ActiveOperation[]>([]);
  const pendingByKey = useRef(new Map<string, Promise<unknown>>());
  const nextId = useRef(0);
  const mounted = useRef(true);
  const { error: showError, success: showSuccess } = useToasts();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingByKey.current.clear();
    };
  }, []);

  const runOperation = useCallback(
    <T,>(input: OperationInput, action: () => Promise<T>): Promise<T> => {
      if (input.key) {
        const pending = pendingByKey.current.get(input.key);
        if (pending) return pending as Promise<T>;
      }

      nextId.current += 1;
      const operation: ActiveOperation = {
        id: `operation-${nextId.current}`,
        key: input.key,
        label: input.label,
        startedAt: Date.now(),
      };
      setOperations((current) => [...current, operation]);

      const promise = (async () => {
        try {
          const result = await action();
          if (mounted.current && input.successMessage) {
            showSuccess(input.successMessage);
          }
          return result;
        } catch (error: unknown) {
          if (mounted.current && input.errorMessage) {
            showError(input.errorMessage(normalizeError(error)));
          }
          throw error;
        } finally {
          if (input.key) pendingByKey.current.delete(input.key);
          if (mounted.current) {
            setOperations((current) => current.filter(({ id }) => id !== operation.id));
          }
        }
      })();

      if (input.key) pendingByKey.current.set(input.key, promise);
      return promise;
    },
    [showError, showSuccess],
  );

  const isPending = useCallback(
    (key: string) => pendingByKey.current.has(key),
    [],
  );

  const value = useMemo(
    () => ({ isPending, operations, runOperation }),
    [isPending, operations, runOperation],
  );

  return <OperationContext.Provider value={value}>{children}</OperationContext.Provider>;
}

export function useOperations(): OperationContextValue {
  const context = useContext(OperationContext);
  if (!context) {
    throw new Error("useOperations must be used within an OperationProvider");
  }
  return context;
}
