import { useState } from "react";
import { Download, Globe, LogIn, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentEnvRegistryStatus } from "@/lib/api";

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
  const [slug, setSlug] = useState("");

  const submitInstall = () => {
    const trimmed = slug.trim();
    if (!trimmed) return;
    onInstall(trimmed);
    setSlug("");
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2">
      <span className="flex items-center gap-1.5 text-xs font-semibold">
        <Globe className="size-3.5 text-muted-foreground" />
        Registry
      </span>

      {status === null ? (
        <span className="text-[11px] text-muted-foreground">Checking sign-in...</span>
      ) : status.signedIn ? (
        <>
          <Badge size="small" variant="success">
            {status.user?.displayName || status.user?.email || "signed in"}
          </Badge>
          {status.source === "env" ? (
            <span className="text-[11px] text-muted-foreground">token from environment</span>
          ) : (
            <Button disabled={busy} onClick={onSignOut} size="sm" variant="ghost">
              <LogOut />
              Sign out
            </Button>
          )}
        </>
      ) : (
        <>
          <span className="text-[11px] text-muted-foreground">
            {status.error ? `Signed out (${status.error})` : "Signed out"}
          </span>
          <Button disabled={signingIn} onClick={onSignIn} size="sm" variant="outline">
            <LogIn />
            {signingIn ? "Waiting for browser..." : "Sign in"}
          </Button>
        </>
      )}

      {status && status.apiMode !== "prod" ? (
        <Badge size="small" variant="warning">
          {status.apiMode === "local" ? "local registry" : status.apiBaseUrl}
        </Badge>
      ) : null}

      <span className="flex-1" />

      <input
        aria-label="Registry profile slug"
        className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs"
        onChange={(event) => setSlug(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submitInstall();
        }}
        placeholder="profile slug"
        value={slug}
      />
      <Button
        disabled={busy || slug.trim().length === 0}
        onClick={submitInstall}
        size="sm"
        variant="outline"
      >
        <Download />
        Install
      </Button>
    </div>
  );
}
