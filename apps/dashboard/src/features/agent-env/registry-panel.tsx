import { useState } from "react";
import { Download, ExternalLink, Globe, LogIn, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentEnvRegistryStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";

/**
 * Hosted profile registry controls (ROR-63): compact header-level sign-in
 * state and install-by-slug. Publishing lives in each profile's overflow menu
 * (ProfilesPanel) since it needs a profile as input.
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
    <section className="ml-auto flex min-w-0 basis-full flex-wrap items-center justify-end gap-1.5 lg:basis-auto lg:flex-1">
      <span className="flex shrink-0 items-center text-muted-foreground" title={t("agentEnv.registryTitle")}>
        <Globe aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{t("agentEnv.registryTitle")}</span>
      </span>

      {status ? (
        <Button
          onClick={() => void openExternal(status.apiFrontendUrl)}
          size="sm"
          variant="ghost"
        >
          <ExternalLink aria-hidden="true" />
          {t("agentEnv.browseRegistry")}
        </Button>
      ) : null}

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

      <span className="flex min-w-0 basis-full items-center justify-end gap-1.5 sm:basis-auto sm:flex-none">
        <input
          aria-label={t("agentEnv.slugAria")}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-44 sm:flex-none"
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
      </span>
    </section>
  );
}
