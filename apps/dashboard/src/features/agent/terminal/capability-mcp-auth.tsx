import type { Translate } from "@/lib/i18n";
import type { McpAuthSummary } from "./agent-capability-data";

/**
 * Whether an agent's MCP servers are signed in, as a dot and a hover title.
 *
 * Its own module because both the capability strip and the dropdown panels
 * render it, and the panels are imported by the strip — so it cannot live in
 * either without a cycle.
 */

export function mcpAuthTitle(t: Translate, auth: McpAuthSummary | null): string | undefined {
  if (!auth) return t("dock.mcpAuthChecking");
  if (auth.needsAuth || auth.failed) {
    return [
      auth.needsAuth ? t("dock.mcpNeedsAuth", { count: auth.needsAuth }) : "",
      auth.failed ? t("dock.mcpFailed", { count: auth.failed }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return auth.checked ? t("dock.mcpConnected") : undefined;
}

export function McpAuthDot({ auth, mcps }: { auth: McpAuthSummary | null; mcps: number }) {
  if (mcps === 0) return null;
  if (!auth) return <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50" />;
  if (auth.failed) return <span className="size-1.5 rounded-full bg-red-500" />;
  if (auth.needsAuth) return <span className="size-1.5 rounded-full bg-amber-500" />;
  if (auth.checked) return <span className="size-1.5 rounded-full bg-emerald-500" />;
  return null;
}
