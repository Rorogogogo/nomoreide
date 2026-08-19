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
  /** Refresh the shared dashboard payload after a widget mutation. */
  onRefresh: () => Promise<void>;
  /**
   * The height the user gave this panel, in row units, or `null` for
   * fit-to-content — and the answer to "how much of my list should I show".
   *
   * Every widget caps its list, because a summary that printed forty log lines
   * or twenty-one skills would be a page, not a summary. That cap used to be
   * unconditional, which made it a lie the moment panels started scrolling
   * (`WidgetScroll`): the panel could show more, the user had made room for
   * more, and the widget still printed six lines and "+34 more".
   *
   * So the cap is now the *unsized* behaviour only. A panel fitting its content
   * keeps its short list, because it decides the page's height and an
   * uncapped one would run the page off the screen. A panel someone dragged a
   * height onto shows everything and scrolls, because that drag is exactly the
   * instruction "I want to see this one".
   *
   * Use it via `rowCap` in `widget-grid.tsx` rather than reading it directly —
   * seven widgets reaching for the same conditional is seven chances to write
   * it differently.
   */
  height: number | null;
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
   * The page this widget summarises. The header arrow opens it — a widget is a
   * summary, and the page is the real thing.
   */
  page: AppPage;
  render(props: WidgetRenderProps): ReactNode;
}
