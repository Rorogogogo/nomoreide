import { useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { GitHubAccountSelector } from "./github-account-selector";
import { GitHubTokenSetup } from "./github-token-setup";
import { GitHubLogo } from "./github-logo";
import type { useGitHubToken } from "./hooks/use-github-token";

/**
 * What the GitHub page shows when it cannot talk to GitHub: a failed account
 * switch, a token that needs re-entering, a repo the token cannot see.
 *
 * Split from `github-view.tsx`, which owns the tabs and the data once a
 * connection works.
 */

export function GitHubConnectionRecovery({
  token,
}: {
  token: ReturnType<typeof useGitHubToken>;
}) {
  const t = useT();
  const [setupMode, setSetupMode] = useState<"device-pending" | "pat" | null>(null);

  if (setupMode) {
    return (
      <GitHubTokenSetup
        deviceFlowAvailable={token.deviceFlowAvailable}
        info={token.info}
        initialMode={setupMode}
        onSaved={token.refresh}
      />
    );
  }

  const authError = token.status === "auth_error";
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      <section aria-labelledby="github-connection-title" className="w-full max-w-lg">
        <div className="flex items-start gap-3">
          <GitHubLogo className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold" id="github-connection-title">
                {t("github.connFailed")}
              </h2>
              <ConnectionState
                label={authError ? t("github.needsRelogin") : t("github.connProblem")}
                tone={authError ? "danger" : "warning"}
              />
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {authError ? t("github.tokenRejected") : t("github.cantValidate")}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Button
                className="h-7 px-2 text-[11px]"
                onClick={() =>
                  setSetupMode(token.deviceFlowAvailable ? "device-pending" : "pat")
                }
                size="sm"
                type="button"
              >
                {t("github.reconnectGithub")}
              </Button>
              {token.info ? (
                <GitHubAccountSelector
                  className="rounded-md border border-border/70 px-0.5"
                  info={token.info}
                  onChanged={token.refresh}
                />
              ) : null}
              <Button
                className="h-7 px-2 text-[11px] [&_svg]:size-3.5"
                onClick={token.refresh}
                size="sm"
                title={t("github.recheckTitle")}
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" />
                {t("common.refresh")}
              </Button>
              {token.deviceFlowAvailable ? (
                <Button
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setSetupMode("pat")}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("github.useToken")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {token.error ? (
          <details className="group mt-5 border-y border-border/70">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-1 py-2 text-[10px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              />
              {t("github.technicalDetails")}
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-border/70 bg-muted/15 px-3 py-2 font-mono text-[10px] leading-4 text-muted-foreground">
              {token.error}
            </pre>
          </details>
        ) : null}
      </section>
    </div>
  );
}

/** Tabs and data only — connection identity belongs to the header indicator. */

export function ConnectionState({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "bg-emerald-500"
      : tone === "danger"
        ? "bg-red-500"
        : "bg-amber-500";

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${toneClass}`} />
      {label}
    </span>
  );
}
