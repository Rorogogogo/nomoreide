import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { fitsSticky, isPinned } from "./home-scroll";

/**
 * The panel's scroll box, and the two things a widget can ask of it.
 *
 * Its own file rather than more of `widget-grid.tsx` because these three are one
 * idea — the box, what stays put inside it, and what follows its end — and
 * because the grid is already the largest file on the page.
 *
 * The box is provided rather than exported: a widget renders *inside* the cell
 * and never builds its own, so the only honest way to hand it the element is
 * from above. `null` until the span mounts, which is why this is state and not a
 * ref — a ref would be attached after its children's layout effects have already
 * run and looked at it, and the first thing anyone wants from this box is a
 * scroll on mount.
 */
const WidgetScrollBox = createContext<HTMLElement | null>(null);

/**
 * The widget's own content, in a box that scrolls rather than clips.
 *
 * A height is an answer to "how much room does this get on my page", and the
 * panel used to read it as "how much of this may I see" — anything past the
 * stored height was cut off with nothing to say it was there. Those are
 * different questions, and only the first one is what anyone means when they
 * drag a corner: a Logs panel sized to eight rows is a decision about the page,
 * not an instruction to throw away the ninth line.
 *
 * So the scroll lives here, on the content, rather than on `WidgetBody`. The
 * header stays put while the content moves under it — a scrolled panel whose
 * title had left the top of it would be a panel you cannot identify — and the
 * resize grip is outside the body entirely, so it stays pinned to the corner it
 * sizes instead of scrolling out of reach.
 *
 * `min-h-0` is what makes it work at all: a flex child's default `min-height:
 * auto` refuses to shrink below its content, so without it the body would grow
 * past the height it was given and the overflow would never happen. `flex-1`
 * has nothing to distribute when the panel is fitting its content, which is why
 * an unsized panel is unaffected by any of this.
 */
export function WidgetScroll({ children }: { children: ReactNode }) {
  const [box, setBox] = useState<HTMLElement | null>(null);
  /* `gap-2` moves down with the content: these used to be `WidgetBody`'s own
     children and spaced by its gap, and a wrapper that did not carry it would
     close up every widget on the page. */
  return (
    <span className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" ref={setBox}>
      <WidgetScrollBox.Provider value={box}>{children}</WidgetScrollBox.Provider>
    </span>
  );
}

/**
 * The part of a widget that belongs to the panel rather than to the scroll —
 * pinned to the top of the box while the rest of it moves underneath.
 *
 * The cell's title already stays put; this is for the widget's own standing
 * context. On Logs that is the tab row, the counters and the graph: which
 * service you are reading, how much it has said, and the shape of the last half
 * hour. All three answer questions *about* the lines, so scrolling them away
 * with the lines leaves you reading output with nothing to say whose it is —
 * and it is exactly when new output arrives, and the box follows it down, that
 * the graph naming the moment is worth the most.
 *
 * Opaque, and `z-10`: the lines pass behind this, and a transparent pin would
 * print them through the graph.
 *
 * **Conditional, and that is the whole subtlety.** Pinning is only a kindness
 * while the pinned thing fits — see `fitsSticky`. Sized short enough, the panel
 * drops the pin and goes back to scrolling everything, because a header taller
 * than its own box can never show you its bottom.
 */
export function WidgetSticky({ children }: { children: ReactNode }) {
  const box = useContext(WidgetScrollBox);
  const [block, setBlock] = useState<HTMLElement | null>(null);
  const [pinned, setPinned] = useState(false);

  /* Measured after every render, deliberately without a dependency array.
     Resizing a panel *is* a render — the height is a prop — so this catches the
     case that matters on the beat it happens, rather than waiting on an
     observer callback that arrives with the next frame, or in a background tab
     never. Setting the same value back is a bail-out in React, so the pass
     converges immediately; and toggling the class changes no geometry at all,
     since `position: sticky` leaves the element in flow. */
  useLayoutEffect(() => {
    if (!box || !block) {
      setPinned(false);
      return;
    }
    setPinned(fitsSticky(block.offsetHeight, box.clientHeight));
  });

  /* The backstop, for the size changes no render announces: the window
     resizing, a font finally loading, the tab row wrapping to a second line.
     Both sides are observed because both move — the box with the panel, the
     block with its own content — and a panel left pinned at a size it no longer
     fits is exactly the trap the guard exists to avoid. */
  useEffect(() => {
    if (!box || !block) return;
    const observer = new ResizeObserver(() =>
      setPinned(fitsSticky(block.offsetHeight, box.clientHeight)),
    );
    observer.observe(box);
    observer.observe(block);
    return () => observer.disconnect();
  }, [box, block]);

  return (
    <span
      className={cn(
        "flex shrink-0 flex-col gap-2",
        pinned && "sticky top-0 z-10 bg-background",
      )}
      ref={setBlock}
    >
      {children}
    </span>
  );
}

/**
 * Keep the box showing its own end as new content arrives — unless the reader
 * has scrolled away from it.
 *
 * A log tail that does not do this is a log tail you have to chase: the newest
 * line is the one you opened the panel for, and it lands below the fold every
 * time. A log tail that does it *unconditionally* is worse — scroll up to the
 * stack trace and the next poll drags you back down.
 *
 * Every render, and with no dependency on *what* changed. The alternative was a
 * key built from the last line, and it was subtly short: the end of the content
 * also moves when the box is resized — a panel given a height stops capping its
 * lines at six and renders the whole tail at once — and no key describing the
 * last line notices that, because the last line is the same one. Following the
 * end is a fact about the box's geometry, so it is re-checked whenever the
 * geometry could have moved, which is every render. When it is already at the
 * end, setting it there again is a no-op.
 *
 * @param stream changes when the panel starts showing a different source. That
 *   re-pins: picking another service's tab is asking for that service's newest
 *   lines, whatever you had scrolled to in the last one.
 */
export function useStickToBottom(stream: string): void {
  const box = useContext(WidgetScrollBox);
  const following = useRef(true);
  const shown = useRef(stream);

  useEffect(() => {
    if (!box) return;
    const onScroll = () => {
      following.current = isPinned(box);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, [box]);

  /* Layout, not effect, and the re-pin lives inside it rather than in an effect
     of its own: effects run after paint and in child-first order, so a separate
     one would set the flag a frame *after* the render that needed it — the tab
     you just picked would sit at the previous tab's scroll position until its
     next line arrived. */
  useLayoutEffect(() => {
    if (!box) return;
    if (shown.current !== stream) {
      shown.current = stream;
      following.current = true;
    }
    if (!following.current) return;
    box.scrollTop = box.scrollHeight;
  });
}
