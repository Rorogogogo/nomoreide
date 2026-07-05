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
const agentDockSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/features/agent/chat/agent-dock.tsx"),
  "utf8",
);
// UI copy now lives in the i18n catalog (t("...")).
const catalog = readFileSync(
  resolve(__dirname, "../src/web/client/src/lib/i18n/en.ts"),
  "utf8",
);

describe("Git file AI input actions", () => {
  test("keeps file AI actions in viewer controls instead of file rows", () => {
    expect(catalog).toContain("Send selected file to AI input");
    expect(gitReviewSource).toContain("onSendToAi");
  });

  test("appends inserted file paths on a new line and focuses the caret at the end", () => {
    expect(agentContextSource).toContain("current.replace(/\\s*$/, \"\")");
    expect(agentContextSource).toContain("}\\n${path}`");
    expect(agentDockSource).toContain("const end = input.value.length");
    expect(agentDockSource).toContain("input.setSelectionRange(end, end)");
  });
});
