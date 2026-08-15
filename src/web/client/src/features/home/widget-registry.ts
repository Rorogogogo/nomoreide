import { activityWidget } from "@/features/activity/widget";
import { agentWidget } from "@/features/agent/widget";
import { databasesWidget } from "@/features/database/widget";
import { repositoryWidget } from "@/features/git/widget";
import { snapshotsWidget } from "@/features/git/snapshots/widget";
import { outputWidget } from "@/features/services/output-widget";
import { healthWidget, portsWidget, servicesWidget } from "@/features/services/widgets";
import type { WidgetDefinition } from "./widget-types";

/**
 * A pure aggregator, exactly like `web/routes/index.ts` and
 * `mcp/tools/index.ts`.
 *
 * Nothing about a widget lives here — not its title, not its span, not how it
 * renders. Adding one means adding a file to the feature that owns it and a
 * line to this list. If this file ever grows a conditional, the contract in
 * `widget-types.ts` is missing a field.
 *
 * Order is the default layout, and every row packs to exactly 12: the three
 * service counters across the top; then Agent beside the repository — an
 * AI-native workbench that reports only processes and ports is describing half
 * of itself; then what you can undo and what you can overwrite, which are the
 * two questions worth answering *before* you start work rather than after; then
 * the two things you read rather than count.
 */
export const WIDGETS: WidgetDefinition[] = [
  servicesWidget,
  healthWidget,
  portsWidget,
  agentWidget,
  repositoryWidget,
  snapshotsWidget,
  databasesWidget,
  activityWidget,
  outputWidget,
];
