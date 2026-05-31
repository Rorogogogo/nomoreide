import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  buildConversationHealth,
  ConversationHealth,
  formatConversationDuration,
} from "../src/web/client/src/features/agent/conversation-health";
import type { ChatTurn } from "../src/web/client/src/features/agent/chat/use-agent-chat";

function turn(id: string, createdAt: number): ChatTurn {
  return {
    id,
    createdAt,
    role: "user",
    text: "hello",
    tools: [],
  };
}

describe("agent conversation health", () => {
  test("formats conversation age in compact human time", () => {
    expect(formatConversationDuration(5 * 60 * 1000)).toBe("5m");
    expect(formatConversationDuration(68 * 60 * 1000)).toBe("1h 08m");
  });

  test("recommends a new chat when the current conversation gets long", () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const turns = Array.from({ length: 18 }, (_, index) =>
      turn(`t${index}`, now - 35 * 60 * 1000 + index),
    );

    const health = buildConversationHealth(turns, now);

    expect(health.status).toBe("long");
    expect(health.statusLabel).toBe("Long");
    expect(health.recommendation).toBe("Consider starting a new chat for a cleaner context.");
    expect(health.durationLabel).toBe("35m");
    expect(health.turnCount).toBe(18);
  });

  test("renders a new chat action for active conversations", () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const markup = renderToStaticMarkup(
      <ConversationHealth
        now={now}
        turns={[turn("t1", now - 90 * 60 * 1000)]}
        onNewChat={() => undefined}
      />,
    );

    expect(markup).toContain("Conversation");
    expect(markup).toContain("1h 30m");
    expect(markup).toContain("Heavy context");
    expect(markup).toContain("New chat");
  });
});
