import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";

/** How many characters the typewriter reveals per animation frame. Small so it
 *  reads character-by-character; nudged up only when far behind so a long burst
 *  still resolves in good time instead of crawling. */
function revealStep(remaining: number): number {
  return Math.min(remaining, Math.max(1, Math.ceil(remaining / 22)));
}

/**
 * Smooths bursty streamed text into a steady, character-by-character typewriter.
 * The agent CLI flushes tokens a whole line at a time; rather than pop each line
 * in, we advance the visible text toward the target a few characters every frame
 * and keep going until it's caught up — even after streaming ends — so the tail
 * never snaps in. Resets instantly only when the text is replaced (new/cleared
 * turn), never when it merely grows.
 */
export function useSmoothText(target: string): string {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  // Snap only when the target no longer extends what we've shown (a different
  // message took its place); a growing target just keeps typing.
  useEffect(() => {
    if (!target.startsWith(displayRef.current)) {
      displayRef.current = target;
      setDisplay(target);
    }
  }, [target]);

  // One step per frame; re-runs itself as `display` advances, stops when caught up.
  useEffect(() => {
    if (displayRef.current.length >= targetRef.current.length) return;
    const raf = requestAnimationFrame(() => {
      const tgt = targetRef.current;
      const next = tgt.slice(0, displayRef.current.length + revealStep(tgt.length - displayRef.current.length));
      displayRef.current = next;
      setDisplay(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [display, target]);

  return display;
}

/** Minimal "the agent is working" hint, shown before any text streams in. */
export function ThinkingIndicator() {
  const t = useT();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Loader2 className="size-3.5 animate-spin" />
      <span>{t("agent.chat.thinking")}</span>
    </div>
  );
}
