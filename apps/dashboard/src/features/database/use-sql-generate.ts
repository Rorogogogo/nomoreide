import { useCallback, useEffect, useRef, useState } from "react";
import { getDatabaseTables, type DatabaseEngine, type TableRef } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { buildGenerateSqlPrompt } from "../agent/prompts";
import { useAgentDock } from "../agent/chat/agent-context";
import { runHeadlessAgentTask } from "../agent/headless/run-headless-agent-task";

/**
 * Natural-language → SQL for the console's Generate field. The app has no LLM of
 * its own, so it runs one isolated headless agent task and reads its explicit
 * result. We parse a single fenced `sql` block out of the reply and
 * hand it back so the console can drop it into the editor for the human to
 * review and run. Nothing is executed here.
 */
export function useSqlGenerate(
  connection: string | null,
  engine: DatabaseEngine | undefined,
  unlocked: boolean,
  onGenerated: (sql: string) => void,
) {
  const t = useT();
  const { provider } = useAgentDock();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const generate = useCallback(
    async (intent: string) => {
      if (!connection || !intent.trim() || generating) return;
      setGenerating(true);
      setError(null);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        // Hand the agent the table list as context; it can introspect columns
        // itself. A failure here is non-fatal — the prompt tells it to inspect.
        let tables: TableRef[] = [];
        try {
          tables = await getDatabaseTables(connection);
        } catch {
          tables = [];
        }
        if (!mountedRef.current || controller.signal.aborted) return;
        const reply = await runHeadlessAgentTask({
          prompt: buildGenerateSqlPrompt(connection, intent, { engine, tables, unlocked }),
          provider: provider?.id,
          signal: controller.signal,
        });
        if (!mountedRef.current || controller.signal.aborted) return;
        const sql = extractSql(reply);
        if (sql) {
          onGenerated(sql);
        } else {
          setError(t("database.sql.noSqlBlock"));
        }
      } catch (caught) {
        if (mountedRef.current && !controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          if (mountedRef.current) setGenerating(false);
        }
      }
    },
    [connection, engine, unlocked, generating, onGenerated, provider?.id, t],
  );

  const cancel = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    abortRef.current = null;
    controller.abort();
    setGenerating(false);
    setError(null);
  }, []);

  return { cancel, generate, generating, error };
}

/**
 * Pull a single SQL statement out of the agent's reply. We pin the prompt to a
 * fenced ```sql block; prefer that, but fall back to a bare fence so a stray
 * language tag doesn't lose the query. Returns null when no fence is present.
 */
function extractSql(reply: string): string | null {
  if (!reply) return null;
  const fenced = /```(?:sql)?\s*\n?([\s\S]*?)```/i.exec(reply);
  const body = fenced?.[1]?.trim();
  return body ? body : null;
}
