import { useEffect, useRef, useState } from "react";
import {
  type ProviderStatusInfo,
} from "@/lib/api";
import { useProviderApi, useProviderId, useProviderManifest } from "./provider-client";

/**
 * Where the user mints an API token, per provider. Same reasoning as
 * `DASHBOARD_URLS` in `deploy-view.tsx`: it belongs in the manifest, and until
 * the manifest carries URLs an unlisted provider gets no button rather than one
 * pointing at the wrong vendor.
 */
const TOKEN_URLS: Record<string, string> = {
  vercel: "https://vercel.com/account/tokens",
  cloudflare: "https://dash.cloudflare.com/profile/api-tokens",
};
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { CliIcon, TokenIcon } from "./provider-icons";
import { ProviderLogo } from "./provider-logo";

/**
 * Connect flow. The CLI path is offered first when `vercel login` has already
 * run — reusing that session beats asking for a token the user would have to
 * mint, and it revokes with `vercel logout` instead of lingering in our config.
 */
export function ProviderSetup({
  info,
  onCancel,
  onConnected,
}: {
  info: ProviderStatusInfo | null;
  onCancel?: () => void;
  onConnected: () => void;
}) {
  const t = useT();
  const api = useProviderApi();
  const providerId = useProviderId();
  const manifest = useProviderManifest();
  const name = manifest?.name ?? info?.provider?.name ?? providerId;
  // Absent manifest means the registry has not answered yet. Withhold the
  // browser path until it does: flashing a "Continue with Cloudflare" button
  // that cannot work is worse than a provider that does support it getting its
  // primary action a frame late.
  const canOAuth = manifest?.authSources.includes("oauth") ?? false;
  const tokenUrl = TOKEN_URLS[providerId];
  const cliAvailable = info?.cliAvailable ?? false;
  const [mode, setMode] = useState<"choose" | "token">("choose");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Stop polling if the user navigates away mid sign-in.
  useEffect(() => () => clearTimeout(pollTimer.current), []);

  /**
   * Opens Vercel's consent page in the real browser, then polls until the
   * backend reports the outcome — the redirect lands on the daemon (web) or on
   * a loopback listener the Rust core opened (desktop), not here, so there is
   * nothing for this component to await. `openExternal` rather than
   * `window.open` because a Tauri webview swallows the latter.
   */
  async function signIn() {
    setSigningIn(true);
    setError(null);
    try {
      const { url } = await api.startOAuth();
      await openExternal(url);
      pollPhase();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSigningIn(false);
    }
  }

  function pollPhase() {
    pollTimer.current = setTimeout(async () => {
      try {
        const phase = await api.getOAuthPhase();
        if (phase.phase === "connected") {
          setSigningIn(false);
          onConnected();
          return;
        }
        if (phase.phase === "error") {
          setError(phase.error);
          setSigningIn(false);
          return;
        }
      } catch {
        // A transient poll failure is not a failed sign-in; keep waiting.
      }
      pollPhase();
    }, 1500);
  }

  async function connect(input: { source: "cli" } | { source: "stored"; token: string }) {
    setBusy(true);
    setError(null);
    try {
      await api.connect(input);
      onConnected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
          <ProviderLogo className="size-5" providerId={providerId} />
        </div>
        <div>
          <h2 className="text-base font-semibold">{t("provider.setup.title", { name })}</h2>
          <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
            {t("provider.setup.desc")}
          </p>
        </div>
      </div>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="flex w-full max-w-xs flex-col gap-2">
        {mode === "choose" ? (
          <>
            {/* Only when the manifest says the provider has a browser sign-in.
                Cloudflare's authorization server serves no OIDC discovery, so
                offering this there would be a button that can only fail. */}
            {canOAuth ? (
              <>
                <Button
                  loading={signingIn}
                  onClick={() => void signIn()}
                  type="button"
                  variant="default"
                >
                  <ProviderLogo className="size-4" providerId={providerId} />
                  {t("provider.setup.signIn", { name })}
                </Button>
                <p className="text-center text-[11px] text-muted-foreground">
                  {signingIn
                    ? t("provider.setup.signInPending", { name })
                    : t("provider.setup.signInHint", { name })}
                </p>
                <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  {t("provider.setup.or")}
                  <span className="h-px flex-1 bg-border" />
                </div>
              </>
            ) : null}
            {cliAvailable ? (
              <Button
                disabled={signingIn}
                loading={busy}
                onClick={() => void connect({ source: "cli" })}
                type="button"
                variant="outline"
              >
                <CliIcon />
                {t("provider.setup.useCli")}
              </Button>
            ) : null}
            <Button
              disabled={signingIn}
              onClick={() => setMode("token")}
              type="button"
              variant="ghost"
            >
              <TokenIcon />
              {t("provider.setup.useToken")}
            </Button>
          </>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (token.trim()) void connect({ source: "stored", token: token.trim() });
            }}
          >
            <Input
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
              placeholder={t("provider.setup.tokenPlaceholder")}
              type="password"
              value={token}
            />
            <Button disabled={!token.trim()} loading={busy} type="submit">
              {t("provider.setup.connect")}
            </Button>
            {tokenUrl ? (
              <Button
                onClick={() => openExternal(tokenUrl)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("provider.setup.createToken")}
              </Button>
            ) : null}
            <Button onClick={() => setMode("choose")} size="sm" type="button" variant="ghost">
              {t("common.back")}
            </Button>
            {!cliAvailable && info?.cliError ? (
              <p className="text-center text-[11px] text-muted-foreground">{info.cliError}</p>
            ) : null}
          </form>
        )}
        {onCancel ? (
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
