import { ChevronLeft, ChevronRight, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { clampSpan, GRID_COLUMNS } from "./home-layout";
import { panelClassName, WidgetPanelHeader } from "./widget-grid";
import type { WidgetDefinition, WidgetSpan } from "./widget-types";

/**
 * Home's edit surface — stage 2 of
 * `docs/plans/2026-08-15-home-dashboard-design.md`.
 *
 * It lives beside the grid rather than inside it because the two have opposite
 * jobs: `widget-grid.tsx` is the vocabulary a widget author writes in, and
 * nothing here is available to a widget. A widget still cannot own a control —
 * these controls belong to the *page*, and they exist only while editing.
 *
 * Nothing is a dialog and nothing is a drag. Reordering is a permutation of a
 * flowing list, so two arrows say everything a drag surface would, and they
 * work from the keyboard for free.
 */

const CONTROL =
  "flex cursor-pointer items-center rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-30 [&_svg]:size-3";

/**
 * The panel's right edge, draggable.
 *
 * This replaced three preset buttons labelled `4 6 12`, which failed the only
 * test that matters: the first person to see them asked what they meant. A
 * width is not a number you should have to convert from — it is the edge of the
 * thing, and the way to say "this wide" is to put the edge there. Twelve
 * columns are still what gets stored; they are now the drag's snap, not a
 * vocabulary anyone has to learn.
 *
 * The grid is the ruler: one twelfth of `[data-widget-grid]` is one column,
 * measured at pointer-down so a mid-drag reflow cannot move the origin
 * underneath the cursor. Arrow keys do the same job a column at a time, because
 * a drag handle that only answers to a mouse is a control half the users of
 * this page cannot reach.
 */
/** Where the drag started: the grid's column width and the panel's left edge. */
interface Drag {
  column: number;
  left: number;
  span: WidgetSpan;
}

/** Which column the cursor is over, measured from where the drag began. */
function spanAt(clientX: number, start: Drag): WidgetSpan {
  return clampSpan((clientX - start.left) / start.column);
}

function WidgetResizeHandle({
  onCommit,
  onPreview,
  span,
  title,
}: {
  onCommit: (span: WidgetSpan) => void;
  onPreview: (span: WidgetSpan | null) => void;
  span: WidgetSpan;
  title: string;
}) {
  const t = useT();
  const release = useRef<(() => void) | null>(null);
  const label = t("home.edit.width", { name: title, span, total: GRID_COLUMNS });

  // A drag that ends outside the handle still has to end. Listening on the
  // window rather than relying on `setPointerCapture` means the release is
  // caught wherever the cursor happens to be, and a pointer id the browser
  // will not let us capture cannot strand the panel mid-resize.
  useEffect(() => () => release.current?.(), []);

  const begin = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const panel = event.currentTarget.parentElement;
    const grid = event.currentTarget.closest("[data-widget-grid]");
    if (!panel || !grid) return;
    event.preventDefault();

    const start: Drag = {
      column: grid.getBoundingClientRect().width / GRID_COLUMNS,
      left: panel.getBoundingClientRect().left,
      span,
    };
    const move = (moved: PointerEvent) => onPreview(spanAt(moved.clientX, start));
    const end = (ended: PointerEvent) => {
      release.current?.();
      release.current = null;
      onPreview(null);
      // Writing preferences on every pointermove would put a `localStorage`
      // write behind every frame of the drag; the preview carries the live
      // width and only the result is saved.
      const next = spanAt(ended.clientX, start);
      if (next !== start.span) onCommit(next);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    release.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  };

  return (
    <button
      aria-label={label}
      /*
        Hidden below `xl`, where the 12-column grid does not apply and a width
        would be a setting with no visible effect. Two pixels of grip, eight of
        target: the bar is quiet enough to sit on every panel at once.
      */
      className="absolute inset-y-0 right-0 z-10 hidden w-2 cursor-col-resize items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring xl:flex"
      onKeyDown={(event) => {
        const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (!delta) return;
        event.preventDefault();
        onCommit(clampSpan(span + delta));
      }}
      onPointerDown={begin}
      title={label}
      type="button"
    >
      <span
        aria-hidden
        className="h-5 w-0.5 rounded-full bg-border transition-colors group-hover/widget:bg-muted-foreground/50"
      />
    </button>
  );
}

/**
 * A widget's cell while the layout is being edited: the same cell, drawn as a
 * `<div>` so it can legally hold the controls a `<button>` could not.
 *
 * Swapping the element remounts the widget's own subtree, so a `fetch`-source
 * widget re-requests once on entering and once on leaving edit mode. That is
 * the honest price of the constraint and a fair one — editing is a thing you do
 * for ten seconds, not a mode you sit in.
 */
export function WidgetEditPanel({
  children,
  canMoveEarlier,
  canMoveLater,
  icon,
  onMove,
  onPreviewSpan,
  onRemove,
  onSpan,
  span,
  title,
}: {
  children: ReactNode;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  icon: ReactNode;
  onMove: (delta: -1 | 1) => void;
  onPreviewSpan: (span: WidgetSpan | null) => void;
  onRemove: () => void;
  onSpan: (span: WidgetSpan) => void;
  span: WidgetSpan;
  title: string;
}) {
  const t = useT();
  return (
    <div className={cn(panelClassName(span), "bg-muted/10")}>
      <WidgetPanelHeader
        icon={icon}
        title={title}
        trailing={
          <span className="ml-auto flex items-center gap-0.5">
            <button
              aria-label={t("home.edit.moveEarlier", { name: title })}
              className={CONTROL}
              disabled={!canMoveEarlier}
              onClick={() => onMove(-1)}
              title={t("home.edit.moveEarlier", { name: title })}
              type="button"
            >
              <ChevronLeft aria-hidden />
            </button>
            <button
              aria-label={t("home.edit.moveLater", { name: title })}
              className={CONTROL}
              disabled={!canMoveLater}
              onClick={() => onMove(1)}
              title={t("home.edit.moveLater", { name: title })}
              type="button"
            >
              <ChevronRight aria-hidden />
            </button>
            <button
              aria-label={t("home.edit.remove", { name: title })}
              className={cn(CONTROL, "hover:text-red-500")}
              onClick={onRemove}
              title={t("home.edit.remove", { name: title })}
              type="button"
            >
              <X aria-hidden />
            </button>
          </span>
        }
      />
      {/*
        Still showing what it shows. Arranging a page of placeholders is
        arranging the wrong page — you pick a width by looking at what sits in
        it, which is exactly the question the Conversations panel raised.
      */}
      <span className="opacity-70">{children}</span>
      <WidgetResizeHandle
        onCommit={onSpan}
        onPreview={onPreviewSpan}
        span={span}
        title={title}
      />
    </div>
  );
}

/**
 * The footer strip: the page's own controls, kept off the top of the page.
 *
 * Home is full-bleed by design (`DESIGN.md`) and a toolbar above the grid would
 * be the first thing you read every visit, to serve the rarest thing you do.
 * The strip is already there for the scope note.
 */
export function HomeEditControls({
  editing,
  hidden,
  onAdd,
  onEdit,
  onFinish,
  onReset,
}: {
  editing: boolean;
  hidden: WidgetDefinition[];
  onAdd: (id: string) => void;
  onEdit: () => void;
  onFinish: () => void;
  onReset: () => void;
}) {
  const t = useT();

  if (!editing) {
    return (
      <button className={cn(CONTROL, "px-1.5 py-0.5 text-[11px]")} onClick={onEdit} type="button">
        {t("home.edit.customize")}
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {hidden.length === 0 ? (
        <span className="pr-1 text-[11px] text-muted-foreground/70">{t("home.edit.allShown")}</span>
      ) : (
        hidden.map((widget) => (
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
        ))
      )}
      <button
        className={cn(CONTROL, "gap-1 px-1.5 py-0.5 text-[11px]")}
        onClick={onReset}
        type="button"
      >
        <RotateCcw aria-hidden />
        {t("home.edit.reset")}
      </button>
      <button
        className={cn(CONTROL, "px-1.5 py-0.5 text-[11px] text-foreground")}
        onClick={onFinish}
        type="button"
      >
        {t("home.edit.done")}
      </button>
    </span>
  );
}
