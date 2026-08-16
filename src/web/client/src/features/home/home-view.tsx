import { useState } from "react";
import type { AppPage } from "@/components/app-navigation";
import { useSettings } from "@/features/settings/settings-context";
import type { HomeLayout } from "@/features/settings/ui-preferences";
import type { DashboardData } from "@/lib/api/services-api";
import { useT } from "@/lib/i18n";
import { HomeEditControls, WidgetControls } from "./home-edit";
import {
  addWidget,
  GRID_COLUMNS,
  hiddenWidgets,
  moveWidget,
  nudgeWidget,
  removeWidget,
  resolveHomeLayout,
  setWidgetSize,
} from "./home-layout";
import { useHomeMasonry } from "./home-masonry";
import { useWidgetMove, WidgetMoveOverlay } from "./home-move";
import { previewResize, type PanelPlacement } from "./home-pack";
import { WidgetDragFrame, WidgetGrid, WidgetPanel } from "./widget-grid";
import { WidgetResizeGrip, type ResizeFrame, type WidgetBox } from "./widget-resize";
import { WIDGETS } from "./widget-registry";
import type { WidgetSpan } from "./widget-types";

/**
 * Home — the page that answers "what is happening right now".
 *
 * The registry is the *default* layout rather than the layout: what is shown,
 * in which row, at what size, is the user's, and it is remembered in
 * `UiPreferences` beside every other view preference.
 *
 * The page still knows nothing about any particular widget. It resolves a saved
 * layout against the registry (`home-layout.ts`), renders the rows that come
 * back, and hands edits straight back to preferences — there is no draft state,
 * so a change is saved the moment it is made and closing the tab mid-edit loses
 * nothing.
 *
 * There is also no edit *mode* (`home-edit.tsx`): every panel carries its own
 * handles, so this renders one kind of panel and holds no state but the drag
 * frame. That collapsed the empty-page problem §8.4 raised, rather than solving
 * it — the picker and Reset are in the footer at all times, so removing the last
 * widget leaves the way back exactly where it always was instead of stranding a
 * page whose only recovery was clearing `localStorage`.
 */
/**
 * The rectangle a width would land in, for the frame the resize draws.
 *
 * The lane count comes from where the panel is *now*, because that is what the
 * grid is currently divided into — asking the packer for a preview in twelfths
 * on a window showing two columns would draw a frame the page cannot honour.
 * When there is nothing to preview against yet — the first pass, before anything
 * has been measured — the panel's own row is the best answer available.
 */
function resizeBox(
  layout: HomeLayout | null,
  id: string,
  span: WidgetSpan,
  place: PanelPlacement | undefined,
): WidgetBox {
  const lanes = place?.lanes ?? GRID_COLUMNS;
  return (
    previewResize(WIDGETS, layout, id, span, lanes) ?? {
      column: place?.column ?? 0,
      span: place?.span ?? span,
      lanes,
    }
  );
}

export function HomeView({
  data,
  onOpen,
  scopeName,
}: {
  data: DashboardData;
  onOpen: (page: AppPage) => void;
  scopeName: string | null;
}) {
  const t = useT();
  const { ui, updateUi } = useSettings();
  /*
    The size under the cursor mid-drag, which is not yet anyone's preference —
    and, deliberately, not yet anyone's layout either. The page holds still
    while a frame moves over it, so the panel you are sizing does not reflow
    away from your cursor mid-gesture and `localStorage` is written once, on
    release. It lives here rather than in the panel because the frame has to be
    drawn outside the grid, which clips its own overflow.
  */
  const [frame, setFrame] = useState<ResizeFrame | null>(null);

  const layout = ui.home;
  const rows = resolveHomeLayout(WIDGETS, layout);
  const hidden = hiddenWidgets(WIDGETS, layout);
  /*
    Rows still say what is beside what; where each panel actually starts is
    measured and packed (`home-pack.ts`), so a short panel no longer holds a
    hole open under itself for the height of the tallest thing beside it.
  */
  const { boxes, grid, height: gridHeight } = useHomeMasonry(rows);

  const apply = (next: HomeLayout) => {
    updateUi({ home: next });
  };

  const { grab, move } = useWidgetMove({
    layout,
    onDrop: (id, target) => apply(moveWidget(WIDGETS, layout, id, target)),
    widgets: WIDGETS,
  });

  /*
    Full-bleed, per `DESIGN.md` — the grid runs to the panel edges and the
    hairlines between widgets are the only structure on the page. No outer
    padding, because padding here would read as a margin around a card.
  */
  return (
    <div className="h-full overflow-y-auto">
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-[12px] text-muted-foreground">{t("home.empty")}</p>
      ) : (
        <WidgetGrid gridRef={grid} height={gridHeight}>
          {/*
            One flat list of panels, because there is no longer a row element to
            nest them in — each panel is placed against the grid itself. Keyed by
            widget id, which appears once on the page: a resize or a drop
            elsewhere leaves every other key alone instead of remounting a
            neighbour, and for a `fetch` widget a remount is a re-request.
          */}
          {rows.flatMap((row, rowIndex) =>
            row.widgets.map(({ height, span, widget }, index) => (
              <WidgetPanel
                controls={
                  <WidgetControls
                    onGrab={grab(widget.id, t(widget.titleKey))}
                    onNudge={(delta) => apply(nudgeWidget(WIDGETS, layout, widget.id, delta))}
                    onRemove={() => apply(removeWidget(WIDGETS, layout, widget.id))}
                    title={t(widget.titleKey)}
                  />
                }
                corner={
                  <WidgetResizeGrip
                    height={height}
                    onFrame={setFrame}
                    onSize={(size) => apply(setWidgetSize(WIDGETS, layout, widget.id, size))}
                    resolveBox={(next) => resizeBox(layout, widget.id, next, boxes.get(widget.id))}
                    span={span}
                    title={t(widget.titleKey)}
                  />
                }
                dragging={move?.id === widget.id}
                height={height}
                icon={widget.icon}
                id={widget.id}
                index={index}
                key={widget.id}
                onOpen={() => onOpen(widget.page)}
                openLabel={t("home.open", { title: t(widget.titleKey) })}
                place={boxes.get(widget.id)}
                row={rowIndex}
                title={t(widget.titleKey)}
              >
                {widget.render({ data, height })}
              </WidgetPanel>
            )),
          )}
        </WidgetGrid>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11px] text-muted-foreground">
        {scopeName ? <span>{t("home.scopedTo", { name: scopeName })}</span> : null}
        <span className="ml-auto">
          <HomeEditControls
            hidden={hidden}
            onAdd={(id) => apply(addWidget(WIDGETS, layout, id))}
            onReset={() => {
              // Back to the registry, not to a stored copy of it: `null` means
              // "never customised", so a widget shipped later shows up again.
              updateUi({ home: null });
            }}
          />
        </span>
      </div>
      <WidgetDragFrame frame={frame} />
      <WidgetMoveOverlay move={move} />
    </div>
  );
}
