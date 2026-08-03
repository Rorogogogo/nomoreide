import { ChevronDown, Loader2 } from "lucide-react";
import type { GitHubTokenInfo } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { GitHubAvatar } from "./github-avatar";
import { GitHubAccountMenu } from "./github-account-menu";
import { useGitHubAccountMenu } from "./hooks/use-github-account-menu";
import { GitHubLogo } from "./github-logo";
import { requestGitHubTokenSetup } from "./github-navigation";
import { refreshGitHubToken, useGitHubToken } from "./hooks/use-github-token";

/** Keeps the menu hook mounted before the first token check resolves. */
const EMPTY_INFO: GitHubTokenInfo = {
  accounts: [],
  cliAvailable: false,
  configured: false,
  deviceFlowAvailable: false,
  status: "not_configured",
  storedConfigured: false,
};

/**
 * GitHub mark + connection dot + account avatar in the app header, and the
 * home of the account menu: the credential is stored per repository, so
 * identity belongs next to the project crumb rather than inside one page's tab
 * row. Names the repository and account through its tooltip rather than inline
 * text — this sits in a row of icon buttons and the repo path is long enough to
 * crowd them.
 */
export function GitHubHeaderIndicator({ onOpenGitHub }: { onOpenGitHub: () => void }) {
  const t = useT();
  const ghToken = useGitHubToken();
  const info = ghToken.info;
  // Hooks run before the early return below so a project switch that clears the
  // token info doesn't change the hook count.
  const menu = useGitHubAccountMenu({
    align: "end",
    info: info ?? EMPTY_INFO,
    onChanged: () => void refreshGitHubToken(),
  });

  // `repositorySlug` comes from the git remote, so the repository can still be
  // named when the account isn't allowed to read it.
  const repoName = info?.repository?.full_name ?? info?.repositorySlug;
  const user = info?.user;
  const dotClass =
    ghToken.status === "connected"
      ? "bg-emerald-500"
      : ghToken.status === "auth_error"
        ? "bg-red-500"
        : ghToken.status === "connection_error" || ghToken.status === "repo_access"
          ? "bg-amber-500"
          : "bg-muted-foreground/40";
  const label = repoName ?? (ghToken.isConnected ? "GitHub" : "");

  // Only the very first load hides the indicator. Re-checks (an account switch
  // elsewhere in the app now reaches this shared store) keep the last known
  // account on screen instead of making the button vanish and reappear.
  if ((ghToken.loading && !info) || (!ghToken.configured && !label)) return null;

  const tooltip = [
    label || "GitHub",
    user ? `@${user.login}` : null,
    // Without this the amber dot reads as "GitHub is down" rather than "this
    // account can't see this repo", which is the one case a tooltip can fix.
    ghToken.status === "repo_access" ? t("github.repoAccess.noAccessShort") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // With no repository resolved there is no credential to switch, so the
  // indicator stays a plain shortcut to the page.
  const hasMenu = Boolean(info?.repositoryName);

  return (
    <div className="relative flex items-center">
      <Tooltip
        align="end"
        disabled={menu.open}
        label={hasMenu ? `${tooltip} · ${t("github.accounts.label")}` : tooltip}
      >
        <button
          aria-expanded={hasMenu ? menu.open : undefined}
          aria-haspopup={hasMenu ? "menu" : undefined}
          aria-label={tooltip}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md border border-transparent px-1.5 transition-colors hover:border-border hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
            hasMenu && menu.open && "border-border bg-muted",
          )}
          disabled={menu.saving}
          onClick={hasMenu ? menu.toggle : onOpenGitHub}
          ref={menu.triggerRef}
          type="button"
        >
          <GitHubLogo className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} />
          {user?.login ? <GitHubAvatar login={user.login} src={user.avatarUrl} /> : null}
          {hasMenu ? (
            menu.saving ? (
              <Loader2
                aria-hidden="true"
                className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
              />
            ) : (
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                  menu.open && "rotate-180",
                )}
              />
            )
          ) : null}
        </button>
      </Tooltip>

      {info ? (
        <GitHubAccountMenu
          controller={menu}
          info={info}
          onAddToken={() => {
            onOpenGitHub();
            requestGitHubTokenSetup("pat");
          }}
          onOpenGitHub={onOpenGitHub}
          onSignIn={() => {
            onOpenGitHub();
            requestGitHubTokenSetup("device-pending");
          }}
        />
      ) : null}

      {menu.error ? (
        <Alert
          aria-live="assertive"
          className="absolute right-0 top-8 z-50 w-72"
          role="alert"
          variant="destructive"
        >
          {menu.error}
        </Alert>
      ) : null}
    </div>
  );
}
