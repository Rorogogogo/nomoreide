import { useEffect } from "react";
import type { AgentTranscriptInfo, AgentTranscriptScope } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { AgentConversationList } from "./agent-conversation-list";

export const HISTORY_RAIL_WIDTH = 232;

/**
 * The conversation sidebar of the new-session surface — prior sessions on the
 * left, the composer on the right, the shape people already know from every AI
 * chat app. It runs the full height of the area under the dock toolbar — the
 * tab strip stays a full-width bar above it, the way app chrome sits above a
 * sidebar rather than beside it.
 *
 * It renders as an in-flow column when the dock is wide enough and as an
 * overlay drawer when it is not, because the dock can be as narrow as 340px
 * side-docked and a permanent column there would leave no room for the
 * composer itself.
 *
 * It carries no header and no "new session" row: the rail is only ever shown
 * beside the composer, so starting a new session is what the surface next to it
 * already does, and the toolbar toggle that opened the rail also closes it.
 */
export function AgentHistoryRail({
  error,
  loading,
  onClose,
  onLoad,
  onResume,
  overlay = false,
  transcripts,
}: {
  error: string | null;
  loading: boolean;
  onClose: () => void;
  onLoad: (scope?: AgentTranscriptScope) => Promise<AgentTranscriptInfo[]>;
  onResume: (transcript: AgentTranscriptInfo) => void;
  overlay?: boolean;
  transcripts: AgentTranscriptInfo[];
}) {
  const t = useT();

  // The rail only mounts when it is revealed, so reloading here is the refresh
  // — there is no button for it, and none of the alternatives (a timer, a
  // stale list) beat re-reading the history each time it comes into view.
  useEffect(() => {
    void onLoad("all");
  }, [onLoad]);

  useEffect(() => {
    if (!overlay) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [onClose, overlay]);

  return (
    <aside
      aria-label={t("dock.conversations")}
      className={cn(
        // Same background as the content beside it — the border alone separates
        // them, so the surface reads as one plane rather than stacked strips.
        "flex shrink-0 flex-col border-r border-border bg-background",
        overlay &&
          "absolute inset-y-0 left-0 z-30 bg-card shadow-[8px_0_24px_-18px_rgba(0,0,0,.6)]",
      )}
      data-agent-history-rail
      style={{ width: HISTORY_RAIL_WIDTH }}
    >
      <AgentConversationList
        error={error}
        loading={loading}
        onResume={onResume}
        transcripts={transcripts}
      />
    </aside>
  );
}
