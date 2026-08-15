import { useState } from "react";
import type { AppPage } from "@/components/app-navigation";
import { useSettings } from "@/features/settings/settings-context";
import type { HomeLayout } from "@/features/settings/ui-preferences";
import type { DashboardData } from "@/lib/api/services-api";
import { useT } from "@/lib/i18n";
import { HomeEditControls, WidgetEditPanel } from "./home-edit";
import {
  addWidget,
  hiddenWidgets,
  moveWidget,
  removeWidget,
  resolveHomeLayout,
  setWidgetSpan,
} from "./home-layout";
import { WidgetGrid, WidgetNote, WidgetPanel } from "./widget-grid";
import { WIDGETS } from "./widget-registry";
import type { WidgetSpan } from "./widget-types";

/**
 * Home — the page that answers "what is happening right now".
 *
 * Stage 2 of `docs/plans/2026-08-15-home-dashboard-design.md`: the registry is
 * now the *default* layout rather than the layout. What is shown, in what
 * order, at what width, is the user's, and it is remembered in `UiPreferences`
 * beside every other view preference.
 *
 * The page still knows nothing about any particular widget. It resolves a saved
 * layout against the registry (`home-layout.ts`), renders what comes back, and
 * hands edits straight back to preferences — there is no draft state, so a
 * change is saved the moment it is made and closing the tab mid-edit loses
 * nothing.
 */
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
  const [editRequested, setEditRequested] = useState(false);
  /*
    The width under the cursor mid-drag, which is not yet anyone's preference.
    Keeping it here rather than in the panel is what lets the drag repaint the
    grid at frame rate while `localStorage` is written once, on release.
  */
  const [preview, setPreview] = useState<{ id: string; span: WidgetSpan } | null>(null);

  const layout = ui.home;
  const placed = resolveHomeLayout(WIDGETS, layout);
  const hidden = hiddenWidgets(WIDGETS, layout);
  /*
    §8.4: removing the last widget must not strand the page. An empty Home
    stays in edit mode, so the picker and Reset are always within reach without
    anyone having to know that clearing `localStorage` is the way out.
  */
  const editing = editRequested || placed.length === 0;

  const apply = (next: HomeLayout) => {
    updateUi({ home: next });
  };

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
        <WidgetGrid>
          {placed.map(({ span, widget }, index) =>
            editing ? (
              <WidgetEditPanel
                canMoveEarlier={index > 0}
                canMoveLater={index < placed.length - 1}
                icon={widget.icon}
                key={widget.id}
                onMove={(delta) => apply(moveWidget(WIDGETS, layout, widget.id, delta))}
                onPreviewSpan={(next) =>
                  setPreview(next === null ? null : { id: widget.id, span: next })
                }
                onRemove={() => apply(removeWidget(WIDGETS, layout, widget.id))}
                onSpan={(next) => apply(setWidgetSpan(WIDGETS, layout, widget.id, next))}
                span={preview?.id === widget.id ? preview.span : span}
                title={t(widget.titleKey)}
              >
                {widget.render({ data })}
              </WidgetEditPanel>
            ) : (
              <WidgetPanel
                icon={widget.icon}
                key={widget.id}
                onOpen={() => onOpen(widget.page)}
                openLabel={t("home.open", { title: t(widget.titleKey) })}
                span={span}
                title={t(widget.titleKey)}
              >
                {widget.render({ data })}
              </WidgetPanel>
            ),
          )}
        </WidgetGrid>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11px] text-muted-foreground">
        {editing ? (
          <WidgetNote>{t("home.edit.hint")}</WidgetNote>
        ) : scopeName ? (
          <span>{t("home.scopedTo", { name: scopeName })}</span>
        ) : null}
        <span className="ml-auto">
          <HomeEditControls
            editing={editing}
            hidden={hidden}
            onAdd={(id) => apply(addWidget(WIDGETS, layout, id))}
            onEdit={() => setEditRequested(true)}
            onFinish={() => setEditRequested(false)}
            onReset={() => {
              // Back to the registry, not to a stored copy of it: `null` means
              // "never customised", so a widget shipped later shows up again.
              updateUi({ home: null });
            }}
          />
        </span>
      </div>
    </div>
  );
}
