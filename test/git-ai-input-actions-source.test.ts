import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const gitReviewSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/features/git/git-review-view.tsx"),
  "utf8",
);
const agentContextSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/features/agent/chat/agent-context.tsx"),
  "utf8",
);
const agentComposerSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/features/agent/terminal/agent-terminal-composer.tsx"),
  "utf8",
);

describe("Git file AI input actions", () => {
  test("keeps file AI actions in viewer controls instead of file rows", () => {
    expect(gitReviewSource).toContain("Send selected file to AI input");
    expect(gitReviewSource).toContain("onSendToAi");
  });

  test("appends inserted file paths on a new line and focuses the caret at the end", () => {
    expect(agentContextSource).toContain("current.replace(/\\s*$/, \"\")");
    expect(agentContextSource).toContain("}\\n${path}`");
    expect(agentComposerSource).toContain("const end = input.value.length");
    expect(agentComposerSource).toContain("input.setSelectionRange(end, end)");
  });
});
