import { useEffect, useState } from "react";
import { listAgentTranscripts, type AgentTranscriptInfo } from "@/lib/api";

/**
 * The agent conversations Home offers to pick back up, newest first.
 *
 * A `fetch`-source widget (see the contract in `features/home/widget-types.ts`)
 * and, by the §7.4 test — judge the endpoint by what it *does* — a cheap one:
 * `/api/terminal/transcripts` reads the provider's own session files off disk,
 * about 90ms for this repository. No subprocess, no network, so it can poll on
 * a normal cadence.
 *
 * **The scope stays `current`.** The endpoint's `all` scope answers with every
 * project on the machine — measured here, 200 conversations and 72KB against 20
 * and 8.7KB — and the widget draws five rows either way. Paying 8× the payload
 * on the page people leave open, for rows that are then thrown away, is the
 * same mistake as reading the 87KB `/api/agent` for one name (§7.3). Scoping to
 * the selected repository is also the better answer: what you were doing *here*
 * is what you are about to resume.
 */

export interface HomeConversationSummary {
  conversations: AgentTranscriptInfo[];
  total: number;
  /** Touched in the last 24h — the ones still in your head. */
  today: number;
  /** See the note on `loaded` in `use-home-agent-summary.ts`. */
  loaded: boolean;
}

const EMPTY: HomeConversationSummary = {
  conversations: [],
  total: 0,
  today: 0,
  loaded: false,
};

const DAY_MS = 86_400_000;

/** Cheap call, so this is just "keep it current", not a cost decision. */
const POLL_MS = 60_000;

export function useHomeConversationSummary(pollMs = POLL_MS): HomeConversationSummary {
  const [summary, setSummary] = useState<HomeConversationSummary>(EMPTY);

  useEffect(() => {
    let active = true;

    const load = async () => {
      // No agent CLI installed, or a repository nobody has run one in, is a
      // normal state rather than an error to render on the landing page.
      const conversations = await listAgentTranscripts().catch(
        () => [] as AgentTranscriptInfo[],
      );
      if (!active) return;

      const cutoff = Date.now() - DAY_MS;
      setSummary({
        conversations,
        total: conversations.length,
        today: conversations.filter((conversation) => {
          const at = Date.parse(conversation.updatedAt);
          return Number.isFinite(at) && at >= cutoff;
        }).length,
        loaded: true,
      });
    };

    void load();
    const interval = window.setInterval(() => void load(), pollMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pollMs]);

  return summary;
}
