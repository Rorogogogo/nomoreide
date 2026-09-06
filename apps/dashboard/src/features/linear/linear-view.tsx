import { useEffect, useState } from "react";
import { requestJson } from "@/lib/api/client";
import { useT, type TranslationKey } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { useAgentDock } from "../agent/chat/agent-context";
import { AiContextTarget } from "../agent/context-menu/ai-context-menu";
import { LinearPanel } from "./linear-panel";
import { linearTaskPrompt, type LinearData, type LinearRequest } from "./linear-types";

const send = async (request: LinearRequest) => (await requestJson<{ data: LinearData }>("/api/linear/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })).data;
export function LinearView() {
  const agent = useAgentDock();
  const translate = useT();
  const t = (key: string) => translate(`linear.${key}` as TranslationKey);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let active = true; void requestJson<{ connected: boolean }>("/api/linear/connection").then((v) => { if (active) setConnected(v.connected); }).catch((e: Error) => { if (active) { setError(e.message); setConnected(false); } }); return () => { active = false; }; }, []);
  async function connection(remove = false) {
    setBusy(true); setError("");
    try { await requestJson("/api/linear/connection", { method: remove ? "DELETE" : "POST", headers: { "content-type": "application/json" }, ...(remove ? {} : { body: JSON.stringify({ token }) }) }); setToken(""); setConnected(!remove); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="flex h-full min-h-0 flex-col">
    {error && <p role="alert" className="p-3 text-red-600">{error}</p>}
    {connected === null ? <p className="p-3">{t("loading")}</p> : connected ? <>
      <div className="flex justify-end border-b border-border px-3 py-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void connection(true)}>{t("disconnect")}</Button></div>
      <LinearPanel send={send} t={t} taskAction={(issue) => <AiContextTarget target={{ label: issue.identifier, intents: [{ id: "linear-task", label: t("work"), resolvePrompt: () => linearTaskPrompt(issue), source: { type: "linear-issue", label: issue.identifier }, agentLabel: `${issue.identifier}: ${issue.title}` }] }}><Button size="sm" onClick={() => agent.sendToAgent({ prompt: linearTaskPrompt(issue), source: { type: "linear-issue", label: issue.identifier }, label: issue.identifier })}>{t("work")}</Button></AiContextTarget>} />
    </> : <form className="mx-auto w-full max-w-md space-y-3 p-6" onSubmit={(e) => { e.preventDefault(); void connection(); }}>
      <h2 className="font-semibold">{t("connect")}</h2><p>{t("setup")}</p>
      <input className="w-full rounded border border-border bg-background p-2" type="password" autoComplete="off" aria-label={t("key")} placeholder={t("key")} required value={token} onChange={(e) => setToken(e.target.value)} />
      <Button type="submit" disabled={busy || !token.trim()}>{t("connect")}</Button>
    </form>}
  </div>;
}
