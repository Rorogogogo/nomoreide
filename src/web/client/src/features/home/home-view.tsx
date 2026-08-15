import type { AppPage } from "@/components/app-navigation";
import type { DashboardData } from "@/lib/api/services-api";
import { useT } from "@/lib/i18n";
import { WidgetCard, WidgetGrid } from "./widget-grid";
import { WIDGETS } from "./widget-registry";

/**
 * Home — the page that answers "what is happening right now".
 *
 * Stage 1 of `docs/plans/2026-08-15-home-dashboard-design.md`: a fixed layout
 * over the dashboard payload the shell already polls, so the whole page costs
 * zero extra requests. Choosing and arranging widgets is stage 2; this stage
 * exists to find out whether the summary is worth having before any of that is
 * built.
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

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <WidgetGrid>
        {WIDGETS.map((widget) => (
          <WidgetCard
            icon={widget.icon}
            key={widget.id}
            onOpen={() => onOpen(widget.page)}
            openLabel={t("home.open", { title: t(widget.titleKey) })}
            span={widget.span}
            title={t(widget.titleKey)}
          >
            {widget.render({ data })}
          </WidgetCard>
        ))}
      </WidgetGrid>
      {scopeName ? (
        <p className="pt-3 text-[11px] text-muted-foreground">
          {t("home.scopedTo", { name: scopeName })}
        </p>
      ) : null}
    </div>
  );
}
