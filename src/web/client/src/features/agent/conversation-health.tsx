import { useEffect, useState } from "react";
import { MessageCircleWarning, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatTurn } from "./chat/use-agent-chat";

type ConversationStatus = "fresh" | "long" | "heavy";

export interface ConversationHealthState {
  durationLabel: string;
  recommendation: string | null;
  status: ConversationStatus;
  statusLabel: string;
  turnCount: number;
}

export function formatConversationDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function buildConversationHealth(
  turns: ChatTurn[],
  now = Date.now(),
): ConversationHealthState {
  const firstTurn = turns[0];
  const durationMs = firstTurn ? now - firstTurn.createdAt : 0;
  const turnCount = turns.length;
  const heavy = durationMs >= 60 * 60_000 || turnCount >= 30;
  const long = durationMs >= 30 * 60_000 || turnCount >= 16;
  const status: ConversationStatus = heavy ? "heavy" : long ? "long" : "fresh";
  return {
    durationLabel: firstTurn ? formatConversationDuration(durationMs) : "0m",
    recommendation:
      status === "fresh" ? null : "Consider starting a new chat for a cleaner context.",
    status,
    statusLabel:
      status === "heavy" ? "Heavy context" : status === "long" ? "Long" : "Fresh",
    turnCount,
  };
}

export function ConversationHealth({
  now,
  onNewChat,
  turns,
}: {
  now?: number;
  onNewChat: () => void;
  turns: ChatTurn[];
}) {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const health = buildConversationHealth(turns, now ?? tick);
  const hasConversation = turns.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background/55 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <MessageCircleWarning
          className={cn(
            "size-4 shrink-0",
            health.status === "heavy"
              ? "text-amber-500"
              : health.status === "long"
                ? "text-yellow-500"
                : "text-muted-foreground",
          )}
        />
        <span className="font-medium">Conversation</span>
        <span className="font-mono text-muted-foreground">
          {hasConversation ? health.durationLabel : "not started"}
        </span>
        {hasConversation ? (
          <span className="font-mono text-muted-foreground">{health.turnCount} turns</span>
        ) : null}
      </div>
      <Badge
        appearance={health.status === "fresh" ? "subtle" : "solid"}
        size="small"
        variant={health.status === "heavy" ? "warning" : health.status === "long" ? "secondary" : "outline"}
      >
        {health.statusLabel}
      </Badge>
      {health.recommendation ? (
        <span className="min-w-0 flex-1 text-muted-foreground">{health.recommendation}</span>
      ) : (
        <span className="min-w-0 flex-1 text-muted-foreground">
          Short chats usually give the agent cleaner context.
        </span>
      )}
      <Button
        className="h-7 gap-1.5 px-2 text-xs"
        disabled={!hasConversation}
        onClick={onNewChat}
        size="sm"
        type="button"
        variant="outline"
      >
        <RotateCcw className="size-3.5" />
        New chat
      </Button>
    </div>
  );
}
