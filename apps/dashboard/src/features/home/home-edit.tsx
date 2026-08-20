import { GripVertical, Plus, RotateCcw, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { WidgetDefinition } from "./widget-types";

/**
 * Home's edit surface — stage 2 of
 * `docs/plans/2026-08-15-home-dashboard-design.md`.
 *
 * It lives beside the grid rather than inside it because the two have opposite
 * jobs: `widget-grid.tsx` is the vocabulary a widget author writes in, and
 * nothing here is available to a widget. These controls belong to the *page*.
 *
 * **What changed: there is no longer a mode.** Arranging Home used to be
 * somewhere you went — a Customize button in the footer swapped every cell for
 * a second panel component that carried the handles, and a Done button swapped
 * them back. Three things were wrong with that, and the third is what settled
 * it:
 *
 * 1. Nobody found it. The one control that revealed the whole feature sat in a
 *    footer strip, under the fold of a full page of widgets.
 * 2. Swapping the element remounted every widget's subtree, so entering and
 *    leaving the mode each cost a `fetch` widget a re-request — a price paid
 *    for a mode that existed only to make controls legal.
 * 3. The mode was never the reason the controls were hidden. It stood in for a
 *    layout constraint: the panel was a `<button>`, so it could not legally
 *    contain one. That constraint is gone, and a mode invented to work around
 *    it had nothing left to justify it.
 *
 * So the handles are simply on the panel, all the time, dimmed until the panel
 * is hovered — the same treatment the arrow already had. The page is arranged
 * where it is read, and there is no state in which a control lies about what it
 * will do.
 *
 * Only one thing here is a drag. A size is a rectangle, so it is dragged
 * (`widget-resize.tsx`); a position is a place on the page, so it is dragged
 * too (`home-move.tsx`) — but both answer to arrow keys from their handle,
 * because a page arrangeable only by mouse is arrangeable by only some people.
 */

const CONTROL =
  "flex cursor-pointer items-center rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-30 [&_svg]:size-3";

/**
 * Quiet until you are looking at the panel.
 *
 * Every panel carries these now, so at rest they are three more marks on a page
 * whose whole argument is that it is scannable. Fading them to the arrow's
 * weight keeps the resting page exactly as quiet as it was before the mode went
 * away, and hovering a panel is already how you find out it is interactive.
 * Focus is unaffected — a keyboard user tabbing here gets the ring and the full
 * contrast, because for them "hover" never arrives.
 */
const DIMMED = "text-muted-foreground/40 group-hover/widget:text-muted-foreground";

/**
 * The per-panel handles: move it, or take it off the page.
 *
 * Deliberately *not* a widget-facing component — it is passed into
 * `WidgetPanel`'s `controls` slot by Home, which is the only thing that knows a
 * layout exists.
 *
 * The resize grip is not here because it is not in the header: it belongs on
 * the corner it sizes, which is the body's, and it goes in the `corner` slot.
 */
export function WidgetControls({
  onGrab,
  onNudge,
  onRemove,
  title,
}: {
  onGrab: (event: ReactPointerEvent<HTMLElement>) => void;
  onNudge: (delta: -1 | 1) => void;
  onRemove: () => void;
  title: string;
}) {
  const t = useT();
  const drag = t("home.edit.drag", { name: title });

  /*
    The arrows that used to be two more buttons in this header.

    A drag says *there* in a way "one place earlier" cannot, so it is the
    gesture the handle is shaped for — but it is also a gesture with no keyboard
    equivalent, and losing reordering entirely is not an acceptable price for a
    tidier header. Folding the steps into the handle keeps both: the thing you
    grab is the thing you focus, and one control now says "move this" in either
    idiom instead of three controls splitting the job.
  */
  const keys = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    onNudge(delta);
  };

  return (
    <>
      <button
        aria-label={drag}
        /* `touch-none` so a drag on a touchpad or tablet is a drag and not the
           page scrolling underneath it, matching the resize grip. */
        className={cn(CONTROL, DIMMED, "cursor-grab touch-none")}
        onKeyDown={keys}
        onPointerDown={onGrab}
        title={drag}
        type="button"
      >
        <GripVertical aria-hidden />
      </button>
      <button
        aria-label={t("home.edit.remove", { name: title })}
        className={cn(CONTROL, DIMMED, "hover:text-red-500")}
        onClick={onRemove}
        title={t("home.edit.remove", { name: title })}
        type="button"
      >
        <X aria-hidden />
      </button>
    </>
  );
}

/**
 * The footer strip: the two controls that are about the page rather than about
 * any one panel — what is missing from it, and starting over.
 *
 * Home is full-bleed by design (`docs/DESIGN.md`) and a toolbar above the grid would
 * be the first thing you read every visit, to serve the rarest thing you do.
 * The strip is already there for the scope note.
 *
 * It no longer gates anything: with the mode gone there is no Customize to
 * press and no Done to remember, so what is left is a picker that shows only
 * when something is off the page, and Reset. Nothing is announced when every
 * widget is shown — an empty picker needs no sentence explaining that it is
 * empty.
 */
export function HomeEditControls({
  hidden,
  onAdd,
  onReset,
}: {
  hidden: WidgetDefinition[];
  onAdd: (id: string) => void;
  onReset: () => void;
}) {
  const t = useT();

  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {hidden.map((widget) => (
        <button
          className={cn(CONTROL, "gap-1 px-1.5 py-0.5 text-[11px]")}
          key={widget.id}
          onClick={() => onAdd(widget.id)}
          title={t("home.edit.add", { name: t(widget.titleKey) })}
          type="button"
        >
          <Plus aria-hidden />
          {t(widget.titleKey)}
        </button>
      ))}
      <button
        className={cn(CONTROL, "gap-1 px-1.5 py-0.5 text-[11px]")}
        onClick={onReset}
        title={t("home.edit.reset")}
        type="button"
      >
        <RotateCcw aria-hidden />
        {t("home.edit.reset")}
      </button>
    </span>
  );
}
