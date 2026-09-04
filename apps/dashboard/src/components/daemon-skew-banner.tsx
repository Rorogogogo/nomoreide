import { AlertTriangle } from "lucide-react";

import { getDaemonVersionSkew, useRuntimeConnection } from "@/lib/runtime-connection";
import { useT } from "@/lib/i18n";

/**
 * The daemon answering this page is not the one this page was built for.
 *
 * Loud, and above the content, because the failures skew produces do not look
 * like skew. A daemon two versions behind answered `auth_error` for a GitHub
 * account that was connected and working, and every other explanation — an
 * expired token, a revoked account, a scope — was more plausible than "the
 * server is old". Hours went into the wrong ones.
 *
 * It names the command rather than offering a button. Restarting stops every
 * service the daemon manages, which is a decision the person in front of it
 * should make deliberately, not by clicking the thing that made the warning go
 * away.
 */
export function DaemonSkewBanner() {
  const connection = useRuntimeConnection();
  const t = useT();
  const skew = getDaemonVersionSkew(connection);

  if (!skew) {
    return null;
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[13px] text-amber-900 dark:text-amber-200"
      role="status"
    >
      <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
      <span>
        {t("app.daemonSkew.message", {
          daemon: skew.daemon,
          client: skew.client,
        })}
      </span>
      <code className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[12px]">
        nomoreide daemon restart
      </code>
      <span className="text-amber-900/70 dark:text-amber-200/70">
        {t("app.daemonSkew.cost")}
      </span>
    </div>
  );
}
