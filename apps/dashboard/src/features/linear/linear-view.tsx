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
const send = async (request: LinearRequest) => (await requestJson<{ data: LinearData }>("/api/linear/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })).data;
export function LinearView() {
  const agent = useAgentDock();
  const translate = useT();
  const t = (key: string) => translate(`linear.${key}` as TranslationKey);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");
  const readConnection = () => requestJson<Connection>("/api/linear/connection");
  useEffect(() => { let active = true; void readConnection().then((v) => { if (active) { setConnected(v.connected); setSource(v.source ?? null); setOauthAvailable(Boolean(v.oauthAvailable)); } }).catch((e: Error) => { if (active) { setError(e.message); setConnected(false); } }); return () => { active = false; }; }, []);
  async function connection(remove = false) {
    setBusy(true); setError("");
    try { await requestJson("/api/linear/connection", { method: remove ? "DELETE" : "POST", headers: { "content-type": "application/json" }, ...(remove ? {} : { body: JSON.stringify({ token }) }) }); setToken(""); setConnected(!remove); setSource(remove ? null : "stored"); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  /**
   * Open Linear's consent screen, then poll until the daemon's callback has
   * had it out with Linear.
   *
   * Polled rather than awaited because the grant does not come back through
   * this request: the browser tab goes to Linear and returns to the daemon's
   * own callback route, so this page only ever learns the outcome second-hand.
   */
  async function signIn() {
    setError(""); setSigningIn(true);
    try {
      const { url } = await requestJson<{ url: string }>("/api/linear/oauth/start", { method: "POST" });
      window.open(url, "_blank", "noopener,noreferrer");
      for (let attempt = 0; attempt < 150; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const { phase, error: reason } = await requestJson<{ phase: string; error?: string }>("/api/linear/oauth/status");
        if (phase === "connected") {
          const now = await readConnection();
          setConnected(now.connected); setSource(now.source ?? "oauth");
          return;
        }
        if (phase === "error") { setError(reason ?? t("oauthFailed")); return; }
      }
      // A tab left open for five minutes is abandoned, not pending. Saying so
      // beats a spinner that never resolves.
      setError(t("oauthFailed"));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSigningIn(false); }
  }
  return <div className="flex h-full min-h-0 flex-col">
    {error && <p role="alert" className="p-3 text-red-600">{error}</p>}
    {connected === null ? <p className="p-3">{t("loading")}</p> : connected ? <>
      <div className="flex items-center justify-between border-b border-border px-3 py-2"><span className="text-xs text-muted-foreground">{t("connectedVia")} {source === "oauth" ? t("viaOauth") : t("viaKey")}</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void connection(true)}>{t("disconnect")}</Button></div>
      <LinearPanel send={send} t={t} taskAction={(issue) => <AiContextTarget target={{ label: issue.identifier, intents: [{ id: "linear-task", label: t("work"), resolvePrompt: () => linearTaskPrompt(issue), source: { type: "linear-issue", label: issue.identifier }, agentLabel: `${issue.identifier}: ${issue.title}` }] }}><Button size="sm" onClick={() => agent.sendToAgent({ prompt: linearTaskPrompt(issue), source: { type: "linear-issue", label: issue.identifier }, label: issue.identifier })}>{t("work")}</Button></AiContextTarget>} />
    </> : <div className="mx-auto w-full max-w-md space-y-4 p-6">
      <h2 className="font-semibold">{t("connect")}</h2>
      {/* Offered only where a Linear OAuth app is configured: a button that
          could only fail is worse than no button. */}
      {oauthAvailable ? <div className="space-y-2">
        <Button className="w-full" disabled={signingIn} onClick={() => void signIn()}>{signingIn ? t("oauthWaiting") : t("oauth")}</Button>
        <p className="text-xs text-muted-foreground">{t("oauthHint")}</p>
        <p className="pt-1 text-xs text-muted-foreground">{t("orKey")}</p>
      </div> : null}
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void connection(); }}>
        <p className="text-sm text-muted-foreground">{t("setup")}</p>
        <input className="w-full rounded border border-border bg-background p-2" type="password" autoComplete="off" aria-label={t("key")} placeholder={t("key")} required value={token} onChange={(e) => setToken(e.target.value)} />
        <Button type="submit" variant={oauthAvailable ? "secondary" : "default"} disabled={busy || !token.trim()}>{t("connect")}</Button>
      </form>
    </div>}
  </div>;
}
