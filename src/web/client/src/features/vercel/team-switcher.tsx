import { useState } from "react";
import { setVercelScope } from "@/lib/api";
import { TeamIcon } from "./vercel-icons";
import { useT } from "@/lib/i18n";
import { refreshVercelStatus, useVercelStatus } from "./hooks/use-vercel-status";

/**
 * Which Vercel scope the dashboard reads.
 *
 * This exists because a Vercel account's projects live under a team, not under
 * the account itself — an unscoped client lists nothing, which looks like an
 * empty account rather than the wrong scope. `vercel-context.ts` adopts the
 * scope automatically when there is only one team; this is what answers when
 * there are several, and what lets anyone move between them afterwards.
 *
 * Rendered as a bare select rather than a dialog: it is a lens on the current
 * view, not a form, so switching should cost one click.
 */
export function TeamSwitcher() {
  const t = useT();
  const { info } = useVercelStatus();
  const [busy, setBusy] = useState(false);
  const teams = info?.teams ?? [];

  // Nothing to switch between: one team is already the adopted default, and
  // zero means this account has no team scope to choose.
  if (teams.length < 2) return null;

  async function choose(teamId: string) {
    setBusy(true);
    try {
      const team = teams.find((entry) => entry.id === teamId);
      await setVercelScope(
        team ? { teamId: team.id, teamSlug: team.slug } : { teamId: undefined },
      );
      await refreshVercelStatus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <TeamIcon aria-hidden className="size-3.5" />
      <span className="sr-only">{t("vercel.team.label")}</span>
      <select
        className="max-w-[12rem] truncate rounded border border-border bg-transparent px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        disabled={busy}
        onChange={(event) => void choose(event.target.value)}
        value={info?.teamId ?? ""}
      >
        <option value="">{t("vercel.team.personal")}</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name ?? team.slug}
          </option>
        ))}
      </select>
    </label>
  );
}
