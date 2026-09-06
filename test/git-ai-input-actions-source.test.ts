import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { catalogSource } from "./support/i18n-source";

const gitReviewSource = readFileSync(
  resolve(__dirname, "../apps/dashboard/src/features/git/git-review-view.tsx"),
  "utf8",
);
const agentContextSource = readFileSync(
  resolve(__dirname, "../apps/dashboard/src/features/agent/chat/agent-context.tsx"),
  "utf8",
);
const agentComposerSource = readFileSync(
  resolve(__dirname, "../apps/dashboard/src/features/agent/terminal/agent-terminal-composer.tsx"),
  "utf8",
);
// UI copy now lives in the i18n catalog (t("...")).
const catalog = catalogSource("en");

describe("Git file AI input actions", () => {
  test("moves file AI actions from viewer buttons to contextual file targets", () => {
    expect(catalog).toContain("Send selected file to AI input");
    expect(gitReviewSource).toContain("agentPath=");
    expect(gitReviewSource).not.toContain("onSendToAi");
  });

  test("appends inserted file paths on a new line and focuses the caret at the end", () => {
    expect(agentContextSource).toContain("current.replace(/\\s*$/, \"\")");
    expect(agentContextSource).toContain("}\\n${path}`");
    expect(agentComposerSource).toContain("const end = input.value.length");
    expect(agentComposerSource).toContain("input.setSelectionRange(end, end)");
  });
});
