import { ChevronLeft, ChevronRight, Plus, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { WIDGET_SPANS } from "./home-layout";
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
            {/*
              The column count itself, not S/M/L. Home's grid is twelve columns
              wide and the number is the whole truth about a width — a "medium"
              that means 6 is a second name for a thing that already had one.
            */}
            {WIDGET_SPANS.map((option) => (
              <button
                className={cn(
                  CONTROL,
                  "px-1 tabular-nums",
                  option === span && "bg-muted text-foreground",
                )}
                key={option}
                onClick={() => onSpan(option)}
                title={t("home.edit.width", { span: option })}
                type="button"
              >
                {option}
              </button>
            ))}
            <button
              aria-label={t("home.edit.moveEarlier", { name: title })}
              className={cn(CONTROL, "ml-1")}
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
