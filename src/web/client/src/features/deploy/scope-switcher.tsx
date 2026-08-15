import { useState } from "react";
import { useProviderApi, useScopeLabel } from "./provider-client";
import { TeamIcon } from "./provider-icons";
import { useLanguage, useT } from "@/lib/i18n";
import { useProviderStatus } from "./hooks/use-provider-status";

/**
 * Which provider scope the dashboard reads.
 *
 * This exists because a Vercel account's projects live under a team, not under
 * the account itself — an unscoped client lists nothing, which looks like an
 * empty account rather than the wrong scope. `providers/project-resolution.ts`
 * adopts the scope automatically when there is only one; this is what answers
 * when there are several, and what lets anyone move between them afterwards.
 *
 * The word for a scope is the provider's own — Vercel calls it a Team,
 * Cloudflare an Account — so the label comes from the manifest's
 * `strings["scope.label"]`, translated per locale, rather than being hard-coded
 * here. It used to be a bare English `scopeLabel` field on the manifest, which
 * meant a zh reader was shown "Team".
 *
 * Rendered as a bare select rather than a dialog: it is a lens on the current
 * view, not a form, so switching should cost one click.
 */
export function ScopeSwitcher() {
  const t = useT();
  const api = useProviderApi();
  const [language] = useLanguage();
  const scopeLabel = useScopeLabel();
  const { info, refresh } = useProviderStatus();
  const [busy, setBusy] = useState(false);
  const scopes = info?.scopes ?? [];

  async function choose(scopeId: string) {
    setBusy(true);
    try {
      const scope = scopes.find((entry) => entry.id === scopeId);
      // An id that is not in the list is a typed one, not the personal scope —
      // only the select's empty option means "clear it".
      await api.setScope(
        scope ? { scopeId: scope.id, scopeSlug: scope.slug } : { scopeId: scopeId || undefined },
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }

  // A provider that cannot read anything unscoped, with nothing to offer:
  // the id has to be typed in, or the dashboard is a dead end. Reached with a
  // Cloudflare token that can use an account but not enumerate accounts.
  if (scopes.length < 2 && info?.provider?.requiresScope) {
    // `useScopeLabel` reads the manifest from `/api/providers`, which this row
    // must not depend on: the status response that carries `requiresScope`
    // carries `scope.label` too, so taking the word from anywhere else means a
    // slower (or failed) second request renders a generic "Scope" instead of
    // the provider's own noun.
    const strings = info.provider.strings;
    const label =
      scopeLabel ?? strings?.[language]?.["scope.label"] ?? strings?.en?.["scope.label"];
    return <ScopeEntry busy={busy} label={label} onSubmit={choose} value={info.scopeId} />;
  }

  // Nothing to switch between: one team is already the adopted default, and
  // zero means this account has no team scope to choose.
  if (scopes.length < 2) return null;

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <TeamIcon aria-hidden className="size-3.5" />
      <span className="sr-only">{scopeLabel ?? t("provider.scope.label")}</span>
      <select
        className="max-w-[12rem] truncate rounded border border-border bg-transparent px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        disabled={busy}
        onChange={(event) => void choose(event.target.value)}
        value={info?.scopeId ?? ""}
      >
        <option value="">{t("provider.team.personal")}</option>
        {scopes.map((scope) => (
          <option key={scope.id} value={scope.id}>
            {scope.name ?? scope.slug}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The scope typed in by hand, for a provider that needs one and cannot list
 * any. A form in the same header slot as the switcher rather than a dialog:
 * it answers the same question, so it should cost no more than typing and
 * Enter.
 *
 * The label is the provider's own word — `scope.label` from its manifest — so
 * Cloudflare reads "Cloudflare account ID" and no provider name is hard-coded
 * here. Both strings take `{name}`, which must be passed: an unsupplied
 * parameter renders the brace literally (see `test/i18n-interpolation.test.ts`).
 */
function ScopeEntry({
  busy,
  label,
  onSubmit,
  value,
}: {
  busy: boolean;
  label?: string | null;
  onSubmit: (scopeId: string) => Promise<void>;
  value?: string;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value ?? "");
  const name = label ?? t("provider.scope.label");
  const dirty = draft.trim() !== "" && draft.trim() !== (value ?? "");

  return (
    <form
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) void onSubmit(draft.trim());
      }}
    >
      <TeamIcon aria-hidden className="size-3.5" />
      <input
        aria-label={t("provider.scope.id", { name })}
        className="w-[13rem] rounded border border-border bg-transparent px-1.5 py-0.5 font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t("provider.scope.id", { name })}
        spellCheck={false}
        title={t("provider.scope.idHint", { name })}
        value={draft}
      />
      {dirty ? (
        <button
          className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-60"
          disabled={busy}
          type="submit"
        >
          {t("provider.scope.set")}
        </button>
      ) : null}
    </form>
  );
}
