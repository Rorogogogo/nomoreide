/**
 * Vertical bounds of the host history sparkline, in the SVG's 0–100 viewBox.
 *
 * Their own module because both the chart component and `activity-format.ts`'s
 * `historyPlotY` need them, and neither should import the other.
 */
export const HISTORY_PLOT_TOP = 4;
export const HISTORY_PLOT_BOTTOM = 96;
