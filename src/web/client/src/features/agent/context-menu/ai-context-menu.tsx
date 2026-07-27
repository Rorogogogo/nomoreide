import {
  cloneElement,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import type { AgentSource } from "../chat/agent-context";

export interface AiContextIntent {
  id: string;
  label: string;
  resolvePrompt: (delivery: "send" | "copy") => string | Promise<string>;
  reportError?: (delivery: "send" | "copy") => boolean;
  source: AgentSource;
  agentLabel?: string;
}

export interface AiContextTargetDescriptor {
  label: string;
  intents: AiContextIntent[];
}

interface AiContextMenuRegistry {
  register: (id: string, target: AiContextTargetDescriptor) => void;
  unregister: (id: string) => void;
  resolve: (element: Element | null) => AiContextTargetDescriptor | null;
}

const AiContextMenuContext = createContext<AiContextMenuRegistry | null>(null);

export function AiContextMenuProvider({ children }: { children: ReactNode }) {
  const targetsRef = useRef(new Map<string, AiContextTargetDescriptor>());
  const registry = useMemo<AiContextMenuRegistry>(
    () => ({
      register(id, target) {
        targetsRef.current.set(id, target);
      },
      unregister(id) {
        targetsRef.current.delete(id);
      },
      resolve(element) {
        const owner = element?.closest<HTMLElement>("[data-ai-context-target]");
        const id = owner?.dataset.aiContextTarget;
        return id ? targetsRef.current.get(id) ?? null : null;
      },
    }),
    [],
  );

  return (
    <AiContextMenuContext.Provider value={registry}>
      {children}
    </AiContextMenuContext.Provider>
  );
}

export function useAiContextMenuRegistry(): AiContextMenuRegistry {
  const registry = useContext(AiContextMenuContext);
  if (!registry) {
    throw new Error("useAiContextMenuRegistry must be used within AiContextMenuProvider");
  }
  return registry;
}

export function useOptionalAiContextMenuRegistry(): AiContextMenuRegistry | null {
  return useContext(AiContextMenuContext);
}

export function AiContextTarget({
  children,
  target,
}: {
  children: ReactElement<Record<string, unknown>>;
  target: AiContextTargetDescriptor;
}) {
  const registry = useOptionalAiContextMenuRegistry();
  const generatedId = useId();
  const id = `ai-context-${generatedId.replace(/:/g, "")}`;

  useEffect(() => {
    if (!registry) return;
    registry.register(id, target);
    return () => registry.unregister(id);
  }, [id, registry, target]);

  return cloneElement(children, { "data-ai-context-target": id });
}
