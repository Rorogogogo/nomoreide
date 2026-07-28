import { useState } from "react";
import { Download, Globe, LogIn, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentEnvRegistryStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Hosted profile registry bar (ROR-63): sign-in state, browser sign-in /
 * sign-out, and install-by-slug. Publishing lives in each profile's overflow
 * menu (ProfilesPanel) since it needs a profile as input.
 */
export function RegistryPanel({
  status,
  busy,
  signingIn,
  onSignIn,
  onSignOut,
  onInstall,
}: {
  status: AgentEnvRegistryStatus | null;
  busy: boolean;
  signingIn: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onInstall: (slug: string) => void;
}) {
  const t = useT();
  const [slug, setSlug] = useState("");

  const submitInstall = () => {
    const trimmed = slug.trim();
    if (!trimmed) return;
    onInstall(trimmed);
    setSlug("");
  };

  return (
    <section className="flex min-w-0 flex-wrap content-start items-center gap-2 bg-background px-3 py-2">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Globe aria-hidden="true" className="size-3.5" />
        {t("agentEnv.registryTitle")}
      </span>

      {status === null ? (
        <span className="text-[11px] text-muted-foreground">{t("agentEnv.checkingSignIn")}</span>
      ) : status.signedIn ? (
        <>
          <Badge size="small" variant="success">
            {status.user?.displayName || status.user?.email || t("agentEnv.signedInFallback")}
          </Badge>
          {status.source === "env" ? (
            <span className="text-[11px] text-muted-foreground">{t("agentEnv.tokenFromEnv")}</span>
          ) : (
            <Button disabled={busy} onClick={onSignOut} size="sm" variant="ghost">
              <LogOut />
              {t("agentEnv.signOut")}
            </Button>
          )}
        </>
      ) : (
        <>
          <span className="text-[11px] text-muted-foreground">
            {status.error ? t("agentEnv.signedOutWithError", { error: status.error }) : t("agentEnv.signedOut")}
          </span>
          <Button disabled={signingIn} onClick={onSignIn} size="sm" variant="outline">
            <LogIn />
            {signingIn ? t("agentEnv.waitingForBrowser") : t("agentEnv.signIn")}
          </Button>
        </>
      )}

      {status && status.apiMode !== "prod" ? (
        <Badge size="small" variant="warning">
          {status.apiMode === "local" ? t("agentEnv.localRegistry") : status.apiBaseUrl}
        </Badge>
      ) : null}

      <span className="flex-1" />

      <input
        aria-label={t("agentEnv.slugAria")}
        className="h-7 w-44 rounded border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => setSlug(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submitInstall();
        }}
        placeholder={t("agentEnv.slugPlaceholder")}
        value={slug}
      />
      <Button
        disabled={busy || slug.trim().length === 0}
        onClick={submitInstall}
        size="sm"
        variant="outline"
      >
        <Download />
        {t("agentEnv.install")}
      </Button>
    </section>
  );
}
