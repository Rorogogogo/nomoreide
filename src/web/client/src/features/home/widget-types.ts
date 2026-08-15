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
 *
 * It starts at 3 rather than 1: a quarter row is the narrowest a stat strip and
 * a row list stay legible in, and a width nobody would keep is not a width
 * worth letting them drag to.
 */
export type WidgetSpan = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

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
   * Where the widget's data comes from.
   *
   * `dashboard` widgets read the payload the shell already polls and cost
   * nothing. `fetch` widgets own their request — the feature that declares the
   * widget also owns the hook that loads it, which is why Home needs no
   * fetching machinery and stays feature-agnostic.
   *
   * It is declared rather than inferred because stage 2 lets a user add
   * widgets, and "this one costs a request" is the fact a picker has to be
   * able to show before they add ten of them.
   */
  source: "dashboard" | "fetch";
  /**
   * The page this widget summarises. The whole card opens it — a widget is a
   * summary, and the page is the real thing.
   */
  page: AppPage;
  render(props: WidgetRenderProps): ReactNode;
}
