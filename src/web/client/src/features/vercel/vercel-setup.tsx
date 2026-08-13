import { useEffect, useRef, useState } from "react";
import {
  type ProviderStatusInfo,
} from "@/lib/api";
import {
  connectVercel,
  getVercelOAuthPhase,
  startVercelOAuth,
} from "./provider-client";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { openExternal } from "@/lib/tauri";
import { CliIcon, TokenIcon } from "./vercel-icons";
import { VercelLogo } from "./vercel-logo";

/**
 * Connect flow. The CLI path is offered first when `vercel login` has already
 * run — reusing that session beats asking for a token the user would have to
 * mint, and it revokes with `vercel logout` instead of lingering in our config.
 */
export function VercelSetup({
  info,
  onCancel,
  onConnected,
}: {
  info: ProviderStatusInfo | null;
  onCancel?: () => void;
  onConnected: () => void;
}) {
  const t = useT();
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
      const { url } = await startVercelOAuth();
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
        const phase = await getVercelOAuthPhase();
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
      await connectVercel(input);
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
          <VercelLogo className="size-5" />
        </div>
        <div>
          <h2 className="text-base font-semibold">{t("vercel.setup.title")}</h2>
          <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
            {t("vercel.setup.desc")}
          </p>
        </div>
      </div>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="flex w-full max-w-xs flex-col gap-2">
        {mode === "choose" ? (
          <>
            <Button
              loading={signingIn}
              onClick={() => void signIn()}
              type="button"
              variant="default"
            >
              <VercelLogo className="size-4" />
              {t("vercel.setup.signIn")}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              {signingIn ? t("vercel.setup.signInPending") : t("vercel.setup.signInHint")}
            </p>
            <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {t("vercel.setup.or")}
              <span className="h-px flex-1 bg-border" />
            </div>
            {cliAvailable ? (
              <Button
                disabled={signingIn}
                loading={busy}
                onClick={() => void connect({ source: "cli" })}
                type="button"
                variant="outline"
              >
                <CliIcon />
                {t("vercel.setup.useCli")}
              </Button>
            ) : null}
            <Button
              disabled={signingIn}
              onClick={() => setMode("token")}
              type="button"
              variant="ghost"
            >
              <TokenIcon />
              {t("vercel.setup.useToken")}
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
              placeholder={t("vercel.setup.tokenPlaceholder")}
              type="password"
              value={token}
            />
            <Button disabled={!token.trim()} loading={busy} type="submit">
              {t("vercel.setup.connect")}
            </Button>
            <Button
              onClick={() => openExternal("https://vercel.com/account/tokens")}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("vercel.setup.createToken")}
            </Button>
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
