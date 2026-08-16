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
 * A closed union rather than a plain number so the two ends of a resize cannot
 * disagree: everything that produces a width goes through `clampSpan`, and
 * anything outside the union is a type error where it is written rather than a
 * panel that lays out somewhere unexpected. It began as a closed union because a
 * span had to become a literal Tailwind class; the span is now arithmetic in
 * `home-pack.ts`, and the union earns its keep as the domain's own bounds.
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
  /**
   * Whether this widget holds controls of its own.
   *
   * Normally it must not: `WidgetPanel` is a single `<button>`, so a control
   * inside it would be invalid HTML and unreachable by keyboard, and a widget
   * that grows its own buttons has started becoming a second, drifting copy of
   * the page it summarises. That rule stands for every widget that can state
   * its summary in one view.
   *
   * The exception is a widget whose summary is genuinely plural — Logs has one
   * stream per running service, and picking between them is not something a
   * static panel can express. Declaring this swaps the element for a `<div>`
   * whose header arrow is the button instead, exactly as edit mode already
   * swaps in `WidgetEditPanel`. The cost is that the card body no longer opens
   * the page, which is why this is opt-in per widget rather than the default.
   */
  interactive?: true;
  render(props: WidgetRenderProps): ReactNode;
}
