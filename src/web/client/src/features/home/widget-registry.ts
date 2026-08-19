import { activityWidget } from "@/features/activity/widget";
import { conversationsWidget } from "@/features/agent/conversations-widget";
import { agentWidget } from "@/features/agent/widget";
import { databasesWidget } from "@/features/database/widget";
import { dockerWidget } from "@/features/docker/widget";
import { repositoryWidget } from "@/features/git/widget";
import { snapshotsWidget } from "@/features/git/snapshots/widget";
import { outputWidget } from "@/features/services/output-widget";
import { healthWidget, servicesWidget } from "@/features/services/widgets";
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
 * Order and width here are the **default** layout — the example a fresh install
 * starts from, and what Reset returns to. Once someone customises Home, their
 * saved list wins and this order is only consulted for widgets they add back
 * (`home-layout.ts`).
 *
 * The default reads: services, health, and Docker across the top; then Agent
 * beside git — an AI-native workbench that reports only processes is
 * describing half of itself; then the conversations you can pick back up
 * beside the restore points you can fall back to; then what you can overwrite
 * and what has been happening; then the last thing a service said. The final
 * row is half empty and that is fine — a layout anyone can edit will have
 * ragged rows constantly, which is why each panel draws its own hairlines.
 *
 * A widget removed from this list disappears from saved layouts too, silently,
 * because `resolveHomeLayout` keeps only ids it can still find (§8.5). That is
 * what retired Ports without anyone having to migrate a stored row.
 */
export const WIDGETS: WidgetDefinition[] = [
  servicesWidget,
  healthWidget,
  dockerWidget,
  agentWidget,
  repositoryWidget,
  conversationsWidget,
  snapshotsWidget,
  databasesWidget,
  activityWidget,
  outputWidget,
];
