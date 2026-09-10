import { useEffect, useState } from "react";
import { requestJson } from "@/lib/api/client";
import { useT, type TranslationKey } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { useAgentDock } from "../agent/chat/agent-context";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
import { LinearPanel } from "./linear-panel";
import { linearTaskPrompt, type LinearData, type LinearRequest } from "./linear-types";

/** What `/api/linear/connection` answers. `source` distinguishes a pasted key
 *  from a browser grant, which is the difference a broken connection turns on. */
type Connection = { connected: boolean; source?: string | null; oauthAvailable?: boolean };

const send = async (request: LinearRequest) =>
  (
    await requestJson<{ data: LinearData }>("/api/linear/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
  ).data;

export function LinearView() {
  const agent = useAgentDock();
  const translate = useT();
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(`linear.${key}` as TranslationKey, params);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");
  const readConnection = () => requestJson<Connection>("/api/linear/connection");

  useEffect(() => {
    let active = true;
    void readConnection()
      .then((value) => {
        if (!active) return;
        setConnected(value.connected);
        setSource(value.source ?? null);
        setOauthAvailable(Boolean(value.oauthAvailable));
      })
      .catch((failure: Error) => {
        if (active) {
          setError(failure.message);
          setConnected(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function connection(remove = false) {
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/linear/connection", {
        method: remove ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        ...(remove ? {} : { body: JSON.stringify({ token }) }),
      });
      setToken("");
      setConnected(!remove);
      setSource(remove ? null : "stored");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Open Linear's consent screen, then poll until the daemon's callback has had
   * it out with Linear.
   *
   * Polled rather than awaited because the grant does not come back through
   * this request: the browser tab goes to Linear and returns to the daemon's
   * own callback route, so this page only ever learns the outcome second-hand.
   */
  async function signIn() {
    setError("");
    setSigningIn(true);
    try {
      const { url } = await requestJson<{ url: string }>("/api/linear/oauth/start", {
        method: "POST",
      });
      window.open(url, "_blank", "noopener,noreferrer");
      for (let attempt = 0; attempt < 150; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const { phase, error: reason } = await requestJson<{ phase: string; error?: string }>(
          "/api/linear/oauth/status",
        );
        if (phase === "connected") {
          const now = await readConnection();
          setConnected(now.connected);
          setSource(now.source ?? "oauth");
          return;
        }
        if (phase === "error") {
          setError(reason ?? t("oauthFailed"));
          return;
        }
      }
      // A tab left open for five minutes is abandoned, not pending. Saying so
      // beats a spinner that never resolves.
      setError(t("oauthFailed"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSigningIn(false);
    }
  }

  if (connected === null) {
    return <p className="px-3 py-4 text-[12px] text-muted-foreground">{t("loading")}</p>;
  }

  if (connected) {
    return (
      <LinearPanel
        onDisconnect={
          <button
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={busy}
            onClick={() => void connection(true)}
            title={source === "oauth" ? t("viaOauth") : t("viaKey")}
            type="button"
          >
            {t("disconnect")}
          </button>
        }
        send={send}
        t={t}
        taskAction={(issue) => (
          <AiContextTarget
            target={{
              label: issue.identifier,
              intents: [
                {
                  id: "linear-task",
                  label: t("work"),
                  resolvePrompt: () => linearTaskPrompt(issue),
                  source: { type: "linear-issue", label: issue.identifier },
                  agentLabel: `${issue.identifier}: ${issue.title}`,
                },
              ],
            }}
          >
            <Button
              size="sm"
              onClick={() =>
                agent.sendToAgent({
                  prompt: linearTaskPrompt(issue),
                  source: { type: "linear-issue", label: issue.identifier },
                  label: issue.identifier,
                })
              }
            >
              {t("work")}
            </Button>
          </AiContextTarget>
        )}
      />
    );
  }

  /* Not connected: the one place a card is right, because it *is* a floating
     island on an otherwise blank panel. */
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        {error && (
          <p className="text-[11px] text-red-600 dark:text-red-500" role="alert">
            {error}
          </p>
        )}
        <h2 className="text-[13px] font-medium">{t("connect")}</h2>
        {oauthAvailable && (
          <div className="space-y-2">
            <Button className="w-full" disabled={signingIn} onClick={() => void signIn()}>
              {signingIn ? t("oauthWaiting") : t("oauth")}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t("oauthHint")}</p>
            <p className="pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("orKey")}
            </p>
          </div>
        )}
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void connection();
          }}
        >
          <p className="text-[11px] text-muted-foreground">{t("setup")}</p>
          <input
            aria-label={t("key")}
            autoComplete="off"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("key")}
            required
            type="password"
            value={token}
          />
          <Button
            disabled={busy || !token.trim()}
            type="submit"
            variant={oauthAvailable ? "secondary" : "default"}
          >
            {t("connect")}
          </Button>
        </form>
      </div>
    </div>
  );
}
