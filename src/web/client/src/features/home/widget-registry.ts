import { activityWidget } from "@/features/activity/widget";
import { repositoryWidget } from "@/features/git/widget";
import {
  healthWidget,
  outputWidget,
  portsWidget,
  servicesWidget,
} from "@/features/services/widgets";
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
 * Order is the default layout for stage 1: three figures across the top, then
 * the two things you read rather than count, then output full width.
 */
export const WIDGETS: WidgetDefinition[] = [
  servicesWidget,
  healthWidget,
  portsWidget,
  repositoryWidget,
  activityWidget,
  outputWidget,
];
