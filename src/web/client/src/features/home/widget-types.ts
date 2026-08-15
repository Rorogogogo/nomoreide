import type { ReactNode } from "react";
import type { AppPage } from "@/components/app-navigation";
import type { DashboardData } from "@/lib/api/services-api";
import type { TranslationKey } from "@/lib/i18n";

/**
 * The widget contract.
 *
 * Stage 1 of `docs/plans/2026-08-15-home-dashboard-design.md`. A widget is
 * **declared by the feature that owns it** — `features/<feature>/widget.tsx` —
 * and the registry is a pure aggregator, exactly as `web/routes/index.ts` and
 * `mcp/tools/index.ts` are. Adding a widget therefore means adding a file to a
 * feature and one line to the registry, never a branch in Home itself.
 *
 * Every stage-1 widget reads the dashboard payload the shell already polls, so
 * a full Home costs zero extra requests. Widgets that need their own fetch
 * arrive in stage 2 and will add a `source` discriminant here; there is no
 * point declaring one while every implementation would pick the same variant.
 */

/**
 * How many of the grid's 12 columns a widget asks for on a wide window.
 *
 * A closed union rather than a number because the span has to become a literal
 * Tailwind class — see `SPAN_CLASS` in `widget-grid.tsx`. Anything the union
 * doesn't list has no class to map to and would silently render full-width.
 */
export type WidgetSpan = 4 | 6 | 12;

export interface WidgetRenderProps {
  data: DashboardData;
}

export interface WidgetDefinition {
  /**
   * Stable across renames and title changes — a saved layout stores this, so
   * changing it in stage 2 silently drops the widget from everyone's Home.
   */
  id: string;
  titleKey: TranslationKey;
  icon: ReactNode;
  span: WidgetSpan;
  /**
   * `repo` widgets read whatever the repository picker has selected. They are
   * marked rather than filtered: Home is global, and a repo-scoped widget says
   * which repository it is showing instead of disappearing when none is.
   */
  scope: "global" | "repo";
  /**
   * The page this widget summarises. The whole card opens it — a widget is a
   * summary, and the page is the real thing.
   */
  page: AppPage;
  render(props: WidgetRenderProps): ReactNode;
}
