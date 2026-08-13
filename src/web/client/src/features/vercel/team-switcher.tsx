import { useState } from "react";
import {
  setVercelScope,
} from "./provider-client";
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
  const scopes = info?.scopes ?? [];

  // Nothing to switch between: one team is already the adopted default, and
  // zero means this account has no team scope to choose.
  if (scopes.length < 2) return null;

  async function choose(scopeId: string) {
    setBusy(true);
    try {
      const scope = scopes.find((entry) => entry.id === scopeId);
      await setVercelScope(
        scope ? { scopeId: scope.id, scopeSlug: scope.slug } : { scopeId: undefined },
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
        value={info?.scopeId ?? ""}
      >
        <option value="">{t("vercel.team.personal")}</option>
        {scopes.map((scope) => (
          <option key={scope.id} value={scope.id}>
            {scope.name ?? scope.slug}
          </option>
        ))}
      </select>
    </label>
  );
}
