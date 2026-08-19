import { useCallback, useState } from "react";
import { flushSync } from "react-dom";

interface DisclosureViewTransition {
  finished: Promise<void>;
}

type DisclosureDocument = Document & {
  startViewTransition?: (update: () => void) => DisclosureViewTransition;
};

/** One temporary content disclosure. It never enters the saved Home layout. */
export function useWidgetDisclosure(): {
  expanded: string | null;
  transitioning: string | null;
  toggleExpanded: (id: string, animate?: boolean) => void;
} {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);

  const toggleExpanded = useCallback((id: string, animate = true) => {
    const update = () => setExpanded((current) => (current === id ? null : id));
    const doc = document as DisclosureDocument;
    if (
      !animate ||
      !doc.startViewTransition ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      update();
      return;
    }

    // Only the panel being disclosed gets a named snapshot. The browser can
    // explain its vertical growth with a transform while masonry repacks.
    flushSync(() => setTransitioning(id));
    const transition = doc.startViewTransition(() => flushSync(update));
    const finish = () => setTransitioning(null);
    void transition.finished.then(finish, finish);
  }, []);

  return { expanded, transitioning, toggleExpanded };
}
