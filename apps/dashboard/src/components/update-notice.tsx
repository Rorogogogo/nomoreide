import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";

import { requestJson } from "@/lib/api/client";
import { useT } from "@/lib/i18n";

type UpdateStatus = {
  current: string;
  latest?: string;
  updateAvailable: boolean;
  upgradeCommand?: string;
};

/**
 * A newer NoMoreIDE has been released.
 *
 * **Quiet, and below the skew banner.** Skew is a live fault — the daemon
 * answering this page disagrees with it, and that produces failures nobody
 * would attribute to versions. This is not a fault at all: everything works,
 * there is simply something better available. A second amber bar would teach
 * people to ignore the first.
 *
 * **It names the command rather than offering a button**, for the same reason
 * the skew banner does: upgrading stops the daemon and every service it
 * manages. Nothing here replaces a binary — see `update_check.rs` for why the
 * daemon does not update itself.
 *
 * Renders nothing at all when up to date, when the check has not answered, or
 * when GitHub could not be reached. An offline laptop has not learned that it
 * is out of date, and a message about the network belongs nowhere near this.
 */
export function UpdateNotice() {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let active = true;
    void requestJson<{ ok: true } & UpdateStatus>("/api/update")
      .then((answer) => {
        if (active) setStatus(answer);
      })
      .catch(() => {
        // A daemon too old to have the route, or no network. Either way there
        // is no news, and no news is not worth a line on the page.
      });
    return () => {
      active = false;
    };
  }, []);

  if (!status?.updateAvailable || !status.latest) {
    return null;
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/30 px-4 py-1.5 text-[12px] text-muted-foreground"
      role="status"
    >
      <ArrowUpCircle aria-hidden className="size-3.5 shrink-0" />
      <span>{t("app.update.available", { version: status.latest })}</span>
      {status.upgradeCommand ? (
        <code className="rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
          {status.upgradeCommand}
        </code>
      ) : null}
    </div>
  );
}
