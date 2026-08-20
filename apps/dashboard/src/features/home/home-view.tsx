import { useState } from "react";
import type { AppPage } from "@/components/app-navigation";
import { useSettings } from "@/features/settings/settings-context";
import type { HomeLayout } from "@/features/settings/ui-preferences";
import type { DashboardData } from "@/lib/api/services-api";
import { useT } from "@/lib/i18n";
import { HomeEditControls, WidgetControls } from "./home-edit";
import { HOME_ROW_PX } from "./home-grid";
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
import { useWidgetDisclosure } from "./use-widget-disclosure";
import { WidgetDragFrame, WidgetGrid, WidgetLoading, WidgetPanel } from "./widget-grid";
import { WidgetResizeGrip, type ResizeFrame, type WidgetBox } from "./widget-resize";
import { WIDGETS } from "./widget-registry";

/** A revealed list gets room to breathe without becoming a second page. */
const DISCLOSURE_HEIGHT = 8;

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
  w: number,
  place: PanelPlacement | undefined,
  measuredRows: Record<string, number>,
): WidgetBox {
  const lanes = place?.lanes ?? GRID_COLUMNS;
  return (
    previewResize(WIDGETS, layout, id, w, measuredRows, lanes) ?? {
      column: place?.column ?? 0,
      span: place?.span ?? w,
      lanes,
    }
  );
}

export function HomeView({
  data,
  onOpen,
  onRefresh,
  scopeName,
}: {
  data: DashboardData | null;
  onOpen: (page: AppPage) => void;
  onRefresh: () => Promise<void>;
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
  const { expanded, toggleExpanded, transitioning } = useWidgetDisclosure();

  const layout = ui.home;
  const placed = resolveHomeLayout(WIDGETS, layout);
  const hidden = hiddenWidgets(WIDGETS, layout);
  /*
    The stored rectangles are intent; where each panel actually lands is packed
    from them (`home-grid.ts`), so nothing overlaps and no gap is left standing
    that something below it could rise into.
  */
  const { boxes, grid, height: gridHeight } = useHomeMasonry(placed);
  /*
    Heights for the resize preview, in rows, read off the boxes the last pass
    produced. The frame has to be drawn against the same numbers the drop will
    pack with, or it promises a rectangle the release does not produce.
  */
  const measuredRows: Record<string, number> = {};
  for (const [id, box] of boxes) measuredRows[id] = Math.round(box.height / HOME_ROW_PX);

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
      {placed.length === 0 ? (
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
          {placed.map(({ tile, widget }) => {
            const isExpanded = expanded === widget.id;
            const shownHeight = isExpanded
              ? Math.max(tile.h ?? DISCLOSURE_HEIGHT, DISCLOSURE_HEIGHT)
              : tile.h;
            return (
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
                    onFrame={setFrame}
                    onSize={(size) => apply(setWidgetSize(WIDGETS, layout, widget.id, size))}
                    resolveBox={(next) =>
                      resizeBox(layout, widget.id, next, boxes.get(widget.id), measuredRows)
                    }
                    span={tile.w}
                    title={t(widget.titleKey)}
                  />
                }
                dragging={move?.id === widget.id}
                expanded={isExpanded}
                height={shownHeight}
                icon={widget.icon}
                id={widget.id}
                key={widget.id}
                lessLabel={t("home.less")}
                onDisclosureToggle={(animate) => toggleExpanded(widget.id, animate)}
                onOpen={() => onOpen(widget.page)}
                openLabel={t("home.open", { title: t(widget.titleKey) })}
                place={boxes.get(widget.id)}
                title={t(widget.titleKey)}
                transitioning={transitioning === widget.id}
              >
                {data ? (
                  widget.render({ data, height: shownHeight, onRefresh })
                ) : (
                  <WidgetLoading label={t("common.loading")} />
                )}
              </WidgetPanel>
            );
          })}
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
