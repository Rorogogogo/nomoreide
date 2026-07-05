import { useCallback, useEffect, useRef, useState } from "react";
import { getDatabaseTables, type DatabaseEngine, type TableRef } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { buildGenerateSqlPrompt } from "../agent/prompts";
import { useAgentDock } from "../agent/chat/agent-context";

/**
 * Natural-language → SQL for the console's Generate field. The app has no LLM of
 * its own — it borrows the dock conversation the same way the workflow runner
 * does: send a prompt in the background, wait for that turn to finish, then read
 * the agent's reply. We parse a single fenced `sql` block out of the reply and
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
  const { sendToAgent, streaming, turns } = useAgentDock();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Always-fresh transcript so we can grab the finished turn's text.
  const turnsRef = useRef(turns);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  // Resolve the in-flight generation the moment the dock turn finishes streaming.
  const sawStreamingRef = useRef(false);
  const idleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (streaming) {
      sawStreamingRef.current = true;
    } else if (sawStreamingRef.current && idleRef.current) {
      const resolve = idleRef.current;
      idleRef.current = null;
      resolve();
    }
  }, [streaming]);

  const generate = useCallback(
    async (intent: string) => {
      if (!connection || !intent.trim() || generating) return;
      setGenerating(true);
      setError(null);

      // Hand the agent the table list as context; it can introspect columns
      // itself. A failure here is non-fatal — the prompt tells it to inspect.
      let tables: TableRef[] = [];
      try {
        tables = await getDatabaseTables(connection);
      } catch {
        tables = [];
      }

      sawStreamingRef.current = false;
      const turnDone = new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          idleRef.current = null;
          resolve();
        };
        idleRef.current = finish;
        // If the turn never starts (no agent configured), don't hang forever.
        const timer = setTimeout(() => {
          if (!sawStreamingRef.current) finish();
        }, 8000);
      });

      sendToAgent({
        prompt: buildGenerateSqlPrompt(connection, intent, { engine, tables, unlocked }),
        source: { type: "database-sql-generate", label: "Generate SQL" },
        label: t("database.sql.generateLabel", { intent }),
        background: true,
      });

      try {
        await turnDone;
        const sql = extractSql(latestAssistantText(turnsRef.current));
        if (sql) {
          onGenerated(sql);
        } else {
          setError(t("database.sql.noSqlBlock"));
        }
      } finally {
        setGenerating(false);
      }
    },
    [connection, engine, unlocked, generating, onGenerated, sendToAgent, t],
  );

  return { generate, generating, error };
}

/** The most recent assistant reply in the transcript. */
function latestAssistantText(turns: ReadonlyArray<{ role: string; text: string }>): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return turns[i].text.trim();
  }
  return "";
}

/**
 * Pull a single SQL statement out of the agent's reply. We pin the prompt to a
 * fenced ```sql block; prefer that, but fall back to a bare fence so a stray
 * language tag doesn't lose the query. Returns null when no fence is present
 * (the reply was prose) so the caller can point the user at the dock instead.
 */
function extractSql(reply: string): string | null {
  if (!reply) return null;
  const fenced = /```(?:sql)?\s*\n?([\s\S]*?)```/i.exec(reply);
  const body = fenced?.[1]?.trim();
  return body ? body : null;
}
