import {
  disconnectVercel,
} from "./provider-client";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { useT } from "@/lib/i18n";
import { TeamIcon, UnlinkIcon } from "./vercel-icons";
import { refreshVercelStatus, useVercelStatus } from "./hooks/use-vercel-status";

/**
 * Which Vercel account the dashboard is signed in as, and how to leave it.
 *
 * Reconnecting and disconnecting used to live only on the connection-failure
 * screen, which meant a working connection was a one-way door: signing in as
 * somebody else — a second personal account, a client's org — required
 * breaking the current one first to make the recovery UI appear. This is the
 * same two actions, reachable while everything is fine.
 *
 * Distinct from `TeamSwitcher`: that moves between teams *inside* one account,
 * which is a lens on the current view. This changes whose account it is, so it
 * sits behind a menu rather than being one click away.
 */
export function VercelAccountMenu({ onSwitchAccount }: { onSwitchAccount: () => void }) {
  const t = useT();
  const { info } = useVercelStatus();
  const username = info?.user?.username;

  return (
    <span className="flex min-w-0 items-center gap-0.5">
      {username ? (
        <span
          className="max-w-[9rem] truncate text-[11px] text-muted-foreground"
          title={t("vercel.connectedAs", { name: username })}
        >
          {username}
        </span>
      ) : null}
      <OverflowMenu
        // The trigger is hover-revealed by default, which suits a row in a
        // list. This one lives in a header with no `group` ancestor to reveal
        // it, so it has to carry its own visibility.
        className="opacity-100"
        items={[
          {
            label: t("vercel.switchAccount"),
            icon: <TeamIcon className="size-3.5" />,
            onSelect: onSwitchAccount,
          },
          {
            label: t("vercel.disconnect"),
            icon: <UnlinkIcon className="size-3.5" />,
            onSelect: () => {
              void disconnectVercel().then(refreshVercelStatus);
            },
          },
        ]}
        label={t("vercel.accountMenu")}
      />
    </span>
  );
}
