import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, Copy, KeyRound, LogIn, LogOut, Plus, User } from "lucide-react";
import type { GitHubTokenInfo } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { GitHubAvatar, githubAvatarUrl } from "./github-avatar";
import {
  ACCOUNT_MENU_WIDTH,
  type GitHubAccountMenuController,
} from "./hooks/use-github-account-menu";

export function GitHubAccountMenu({
  controller,
  info,
  onAddToken,
  onOpenGitHub,
  onSignIn,
}: {
  controller: GitHubAccountMenuController;
  info: GitHubTokenInfo;
  /** Opens the personal-access-token flow; omitted while already inside it. */
  onAddToken?: () => void;
  /** Navigates to the GitHub page — the header trigger's former click action. */
  onOpenGitHub?: () => void;
  /** Opens GitHub's browser authorization — the everyday "add an account". */
  onSignIn?: () => void;
}) {
  const t = useT();
  if (!controller.open) return null;

  const current = info.credential ?? info.selected;
  const selectedGhMissing =
    current?.source === "gh" &&
    !info.accounts.some(
      (account) => account.host === current.host && account.login === current.login,
    );

  return createPortal(
    <div
      className="fixed z-50 flex max-h-[min(28rem,calc(100vh-4rem))] min-w-52 flex-col overflow-y-auto rounded-md border border-border bg-card p-1 shadow-md"
      ref={controller.menuRef}
      role="menu"
      style={{ left: controller.coords.left, top: controller.coords.top, width: ACCOUNT_MENU_WIDTH }}
    >
      <MenuSectionLabel>{t("github.accounts.label")}</MenuSectionLabel>

      {selectedGhMissing && current?.source === "gh" ? (
        <AccountMenuRow
          active={true}
          badge={t("github.accounts.needsLogin")}
          badgeColor="amber"
          icon={
            <GitHubAvatar
              className="size-3.5"
              fallback={<User className="size-3.5 text-amber-500" />}
              login={current.login}
              src={githubAvatarUrl(current.host, current.login)}
            />
          }
          label={`@${current.login}`}
          onSelect={() => void controller.select(current)}
        />
      ) : null}

      {info.accounts
        .filter((account) => account.host === "github.com")
        .map((account) => {
          const isSelected = current?.source === "gh" && current.login === account.login;
          return (
            <AccountMenuRow
              active={isSelected}
              badge={account.active ? t("github.accounts.cliActive") : undefined}
              badgeColor="emerald"
              icon={
                <GitHubAvatar
                  className="size-3.5"
                  fallback={<User className="size-3.5 text-muted-foreground" />}
                  login={account.login}
                  src={githubAvatarUrl(account.host, account.login)}
                />
              }
              key={`${account.host}:${account.login}`}
              label={`@${account.login}`}
              onSelect={() =>
                void controller.select({
                  source: "gh",
                  host: account.host,
                  login: account.login,
                })
              }
            />
          );
        })}

      {/* The stored token and its removal sit together: "remove" acts on that
          one row, and it is the only sign-out NoMoreIDE owns — a `gh`
          credential belongs to the CLI, so the menu simply has nothing to
          offer there. */}
      {info.storedConfigured ? (
        <>
          <div className="my-1 h-px shrink-0 bg-border" />
          <AccountMenuRow
            active={current?.source === "stored"}
            icon={<KeyRound className="size-3.5 text-muted-foreground" />}
            label={t("github.accounts.nomoreideToken")}
            onSelect={() => void controller.select({ source: "stored", host: "github.com" })}
          />
          <AccountMenuRow
            danger
            icon={<LogOut className="size-3.5 text-destructive" />}
            label={t("github.accounts.removeToken")}
            onSelect={() => void controller.disconnect()}
          />
        </>
      ) : null}

      {/* Both ways in were reachable only from the setup and failure screens,
          which never appear while a `gh` account works — so someone whose
          accounts all lack access to a repo had no way to add another short of
          breaking the connection first. */}
      {onSignIn || onAddToken ? (
        <>
          <MenuSectionLabel>{t("github.accounts.addSection")}</MenuSectionLabel>
          {onSignIn && info.deviceFlowAvailable ? (
            <AccountMenuRow
              icon={<LogIn className="size-3.5 text-muted-foreground" />}
              label={`${t("github.accounts.signIn")}…`}
              onSelect={() => {
                controller.close();
                onSignIn();
              }}
            />
          ) : null}
          {onAddToken ? (
            <AccountMenuRow
              icon={<Plus className="size-3.5 text-muted-foreground" />}
              label={`${t("github.accounts.addToken")}…`}
              onSelect={() => {
                controller.close();
                onAddToken();
              }}
            />
          ) : null}
          {/* A `gh` account can only be added by `gh` itself. Naming the command
              beats leaving people to guess why their other login isn't listed. */}
          <CommandHint command="gh auth login" hint={t("github.accounts.cliAddHint")} />
        </>
      ) : null}

      {onOpenGitHub ? (
        <>
          <div className="my-1 h-px shrink-0 bg-border" />
          <AccountMenuRow
            icon={<ArrowUpRight className="size-3.5 text-muted-foreground" />}
            label={t("github.accounts.openPage")}
            onSelect={() => {
              controller.close();
              onOpenGitHub();
            }}
          />
        </>
      ) : null}
    </div>,
    document.body,
  );
}

function MenuSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 px-2 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground first:pt-1">
      {children}
    </div>
  );
}

/**
 * A step only the GitHub CLI can take, handed over as a copyable command. Not a
 * button: running `gh auth login`/`logout` for someone would reach outside this
 * app and change how every other tool on their machine authenticates.
 */
function CommandHint({ command, hint }: { command: string; hint: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="shrink-0 px-2 pb-1.5 pt-1">
      <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>
      <button
        aria-label={`${t("common.copy")} ${command}`}
        className="mt-1 flex w-full items-center gap-1.5 rounded-sm border border-border bg-muted/50 px-1.5 py-1 text-left transition-colors hover:bg-muted"
        onClick={copy}
        type="button"
      >
        <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground">
          {command}
        </code>
        {copied ? (
          <Check className="size-3 shrink-0 text-emerald-500" />
        ) : (
          <Copy className="size-3 shrink-0 text-muted-foreground" />
        )}
      </button>
    </div>
  );
}

function AccountMenuRow({
  active,
  badge,
  badgeColor = "emerald",
  danger = false,
  icon,
  label,
  onSelect,
}: {
  active?: boolean;
  badge?: string;
  badgeColor?: "emerald" | "amber";
  danger?: boolean;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full shrink-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted font-mono",
        active && "bg-muted/60 font-semibold",
        danger && "text-destructive hover:bg-destructive/10",
      )}
      onClick={onSelect}
      role="menuitem"
      type="button"
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span
          className={cn(
            "rounded px-1 py-0.5 font-sans text-[9px] font-medium shrink-0",
            badgeColor === "emerald" && "bg-emerald-500/10 text-emerald-500",
            badgeColor === "amber" && "bg-amber-500/10 text-amber-500",
          )}
        >
          {badge}
        </span>
      ) : null}
      {active ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </button>
  );
}
