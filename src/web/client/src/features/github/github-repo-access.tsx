import { ExternalLink, Lock, RefreshCw } from "lucide-react";
import type { GitHubTokenInfo } from "@/lib/api";
import { Button, buttonVariants } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { GitHubAccountSelector } from "./github-account-selector";

/**
 * Shown when the credential authenticated fine and GitHub answered "no such
 * repository for you" (a 404). That is an access problem, not a connection
 * problem, so this deliberately does *not* look like the failure card: no red,
 * no "reconnect", and the signed-in account is stated as a fact. The fix is
 * almost always switching account, so the account picker is the primary action.
 */
export function GitHubRepoAccessNotice({
  info,
  onRefresh,
  onUseToken,
}: {
  info: GitHubTokenInfo;
  onRefresh: () => void;
  onUseToken: () => void;
}) {
  const t = useT();
  const slug = info.repositorySlug ?? info.repositoryName ?? "";
  const login = info.user?.login;

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-4 rounded-md border border-border bg-card p-5">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-amber-500/10">
            <Lock className="size-3 text-amber-500" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">
              {t("github.repoAccess.title", { repo: slug })}
            </h2>
            <p className="text-[12px] text-muted-foreground">
              {login
                ? t("github.repoAccess.bodyWithAccount", { login, repo: slug })
                : t("github.repoAccess.body", { repo: slug })}
            </p>
          </div>
          {/* Green: the connection itself is healthy, and saying so is the
              whole point of this screen. */}
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {t("github.repoAccess.signedIn")}
          </span>
        </div>

        <ul className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-[12px] text-muted-foreground">
          <li>• {t("github.repoAccess.causePrivate")}</li>
          <li>• {t("github.repoAccess.causeRenamed")}</li>
          <li>• {t("github.repoAccess.causeOrg")}</li>
        </ul>

        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("github.repoAccess.switchPrompt")}
          </p>
          {/* The picker already names the current account, so nothing repeats
              it here — it is the control, not a status line. */}
          <div className="w-fit rounded-md border border-border px-1">
            <GitHubAccountSelector
              info={info}
              onAddToken={onUseToken}
              onChanged={onRefresh}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={onRefresh} type="button" variant="outline">
            <RefreshCw />
            {t("common.refresh")}
          </Button>
          {slug ? (
            <a
              className={buttonVariants({ variant: "outline" })}
              href={`https://github.com/${slug}`}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink />
              {t("github.repoAccess.openOnGithub")}
            </a>
          ) : null}
          <Button onClick={onUseToken} type="button" variant="outline">
            {t("github.repoAccess.useTokenWithAccess")}
          </Button>
        </div>
      </div>
    </div>
  );
}
