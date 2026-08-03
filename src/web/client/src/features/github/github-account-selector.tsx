import { ChevronDown, KeyRound, Loader2, User } from "lucide-react";
import type { GitHubTokenInfo } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { GitHubAvatar, githubAvatarUrl } from "./github-avatar";
import { GitHubAccountMenu } from "./github-account-menu";
import { useGitHubAccountMenu } from "./hooks/use-github-account-menu";

/**
 * Named trigger for the account menu, used on the connection-recovery screen.
 * The everyday entry point is the header indicator — the menu lives beside the
 * project crumb because the credential is stored per repository. This one stays
 * because recovery is exactly when the header can't be trusted to show it.
 */
export function GitHubAccountSelector({
  info,
  onChanged,
  onAddToken,
  className,
}: {
  info: GitHubTokenInfo;
  onChanged: () => void;
  /** Opens the personal-access-token flow; omitted while already inside it. */
  onAddToken?: () => void;
  className?: string;
}) {
  const t = useT();
  const menu = useGitHubAccountMenu({ info, onChanged });

  const current = info.credential ?? info.selected;

  /**
   * Nothing to choose between: no repository to attach a credential to, or no
   * credential of any kind on the machine. Checked *after* the hook above —
   * bailing before it changes the hook count when a project switch clears
   * `repositoryName`.
   */
  const nothingToSelect =
    !info.repositoryName || (info.accounts.length === 0 && !info.storedConfigured);

  if (nothingToSelect) {
    return info.cliError ? (
      <span className="max-w-56 truncate text-[10px] text-muted-foreground" title={info.cliError}>
        {t("github.accounts.unavailable")}
      </span>
    ) : null;
  }

  const currentLabel =
    current?.source === "gh"
      ? `@${current.login}`
      : info.storedConfigured
        ? t("github.accounts.nomoreideToken")
        : t("github.accounts.choose");

  return (
    <div className={cn("relative flex min-w-0 items-center gap-1.5", className)}>
      <button
        aria-describedby={menu.error ? "github-account-error" : undefined}
        aria-expanded={menu.open}
        aria-haspopup="menu"
        aria-label={t("github.accounts.label")}
        className={cn(
          "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-left transition-colors hover:border-border hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
          menu.open && "border-border bg-muted",
        )}
        disabled={menu.saving}
        id="github-account-select"
        onClick={menu.toggle}
        ref={menu.triggerRef}
        type="button"
      >
        <span className="flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-semibold text-muted-foreground">
          {current?.source === "gh" ? (
            <GitHubAvatar
              fallback={<User className="size-3" />}
              login={current.login}
              src={githubAvatarUrl(current.host, current.login)}
            />
          ) : (
            <KeyRound className="size-3" />
          )}
        </span>
        <span className="truncate font-mono text-[11px]">{currentLabel}</span>
        {menu.saving ? (
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
        )}
      </button>

      <GitHubAccountMenu controller={menu} info={info} onAddToken={onAddToken} />

      {menu.error ? (
        <Alert
          aria-live="assertive"
          className="absolute right-0 top-8 z-20 w-72"
          id="github-account-error"
          role="alert"
          variant="destructive"
        >
          {menu.error}
        </Alert>
      ) : null}
    </div>
  );
}
