import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { listAgentTranscripts } from "../src/core/agent-transcripts.js";

const REPO = "/Users/dev/work/Personal Project/nomoreide";
const OTHER = "/Users/dev/work/other-repo";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nomoreide-transcripts-"));
});

/** Writes a Claude transcript into `~/.claude/projects/<dir>/<id>.jsonl`. */
async function writeClaude(dir: string, id: string, lines: unknown[]) {
  const target = join(home, ".claude", "projects", dir);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function claudeSession(id: string, cwd: string, prompt: string, extra: unknown[] = []) {
  return [
    { type: "mode", mode: "normal", sessionId: id },
    ...extra,
    { type: "user", isSidechain: false, message: { role: "user", content: prompt }, cwd, sessionId: id, timestamp: "2026-07-19T02:00:00.000Z" },
  ];
}

/** Writes a Codex rollout into `~/.codex/sessions/YYYY/MM/DD/`. */
async function writeCodex(
  date: [string, string, string],
  id: string,
  cwd: string,
  prompt: string,
  beforePrompt: string[] = [],
) {
  const [year, month, day] = date;
  const target = join(home, ".codex", "sessions", year, month, day);
  await mkdir(target, { recursive: true });
  const lines = [
    { timestamp: "2026-07-19T03:00:00.000Z", type: "session_meta", payload: { session_id: id, cwd, timestamp: "2026-07-19T03:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] } },
    ...beforePrompt.map((text) => ({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    })),
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
  ];
  await writeFile(join(target, `rollout-${year}-${month}-${day}T09-00-00-${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("listAgentTranscripts", () => {
  test("returns sessions from both providers for the repo", async () => {
    await writeClaude("-Users-dev-work-Personal-Project-nomoreide", "claude-1", claudeSession("claude-1", REPO, "add a resume picker"));
    await writeCodex(["2026", "07", "19"], "codex-1", REPO, "fix the failing test");

    const rows = await listAgentTranscripts({ repoPath: REPO, homeDir: home });

    expect(rows.map((row) => [row.provider, row.id, row.title])).toEqual(
      expect.arrayContaining([
        ["claude", "claude-1", "add a resume picker"],
        ["codex", "codex-1", "fix the failing test"],
      ]),
    );
  });

  test("finds Claude sessions across the slug encodings different releases wrote", async () => {
    // Older releases kept spaces and dots; newer ones replace them with dashes.
    await writeClaude("-Users-dev-work-Personal Project-nomoreide", "old", claudeSession("old", REPO, "written by an older release"));
    await writeClaude("-Users-dev-work-Personal-Project-nomoreide", "new", claudeSession("new", REPO, "written by a newer release"));

    const rows = await listAgentTranscripts({ repoPath: REPO, homeDir: home });

    expect(rows.map((row) => row.id).sort()).toEqual(["new", "old"]);
  });

  test("drops sessions whose recorded cwd is a different repo", async () => {
    // The slug comparison is lossy, so a sibling path can land in a matching
    // directory — the body's cwd is what actually decides.
    await writeClaude("-Users-dev-work-Personal-Project-nomoreide", "wrong", claudeSession("wrong", OTHER, "belongs elsewhere"));
    await writeCodex(["2026", "07", "19"], "codex-other", OTHER, "also elsewhere");

    expect(await listAgentTranscripts({ repoPath: REPO, homeDir: home })).toEqual([]);
    expect(await listAgentTranscripts({ homeDir: home })).toHaveLength(2);
  });

  test("skips injected context in favour of the first typed prompt", async () => {
    await writeClaude("-Users-dev-work-Personal-Project-nomoreide", "c", [
      { type: "mode", sessionId: "c" },
      { type: "user", isSidechain: false, message: { role: "user", content: "<command-name>/commit-push</command-name>" }, cwd: REPO, timestamp: "2026-07-19T02:00:00.000Z" },
      { type: "user", isSidechain: false, message: { role: "user", content: "the real question" }, cwd: REPO, timestamp: "2026-07-19T02:01:00.000Z" },
    ]);

    const [row] = await listAgentTranscripts({ repoPath: REPO, homeDir: home });

    expect(row.title).toBe("the real question");
  });

  test("reads Claude content given as typed blocks rather than a string", async () => {
    await writeClaude("-Users-dev-work-Personal-Project-nomoreide", "b", [
      { type: "mode", sessionId: "b" },
      { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "text", text: "block form prompt" }] }, cwd: REPO, timestamp: "2026-07-19T02:00:00.000Z" },
    ]);

    const [row] = await listAgentTranscripts({ repoPath: REPO, homeDir: home });

    expect(row.title).toBe("block form prompt");
  });

  test("ignores a sidechain prompt so subagent turns never title a session", async () => {
    await writeClaude("-Users-dev-work-Personal-Project-nomoreide", "s", [
      { type: "mode", sessionId: "s" },
      { type: "user", isSidechain: true, message: { role: "user", content: "subagent instruction" }, cwd: REPO, timestamp: "2026-07-19T02:00:00.000Z" },
      { type: "user", isSidechain: false, message: { role: "user", content: "human prompt" }, cwd: REPO, timestamp: "2026-07-19T02:01:00.000Z" },
    ]);

    const [row] = await listAgentTranscripts({ repoPath: REPO, homeDir: home });

    expect(row.title).toBe("human prompt");
  });

  test("skips Codex-injected AGENTS instructions when choosing the title", async () => {
    await writeCodex(
      ["2026", "07", "20"],
      "codex-agent-rules",
      REPO,
      "the actual task",
      [`# AGENTS.md instructions for ${REPO}\n<INSTRUCTIONS>rules</INSTRUCTIONS>`],
    );

    const [row] = await listAgentTranscripts({ repoPath: REPO, homeDir: home });

    expect(row.title).toBe("the actual task");
  });

  test("survives a truncated tail line", async () => {
    const target = join(home, ".claude", "projects", "-Users-dev-work-Personal-Project-nomoreide");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "t.jsonl"),
      `${JSON.stringify({ type: "mode", sessionId: "t" })}\n{"type":"user","message":{"cont\n${JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "after the tear" }, cwd: REPO, timestamp: "2026-07-19T02:00:00.000Z" })}\n`,
    );

    const [row] = await listAgentTranscripts({ repoPath: REPO, homeDir: home });

    expect(row.title).toBe("after the tear");
  });

  test("sorts most recently written first and honours the limit", async () => {
    await writeClaude("-Users-dev-work-Personal-Project-nomoreide", "one", claudeSession("one", REPO, "first"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeClaude("-Users-dev-work-Personal-Project-nomoreide", "two", claudeSession("two", REPO, "second"));

    const rows = await listAgentTranscripts({ repoPath: REPO, homeDir: home });
    expect(rows.map((row) => row.id)).toEqual(["two", "one"]);

    expect(await listAgentTranscripts({ repoPath: REPO, homeDir: home, limit: 1 })).toHaveLength(1);
  });

  test("returns more than thirty recent sessions by default", async () => {
    await Promise.all(
      Array.from({ length: 35 }, (_, index) => {
        const id = `session-${index}`;
        return writeClaude(
          "-Users-dev-work-Personal-Project-nomoreide",
          id,
          claudeSession(id, REPO, `conversation ${index}`),
        );
      }),
    );

    expect(await listAgentTranscripts({ repoPath: REPO, homeDir: home })).toHaveLength(35);
  });

  test("keeps a full recent window for each provider", async () => {
    await Promise.all([
      writeClaude(
        "-Users-dev-work-Personal-Project-nomoreide",
        "claude-one",
        claudeSession("claude-one", REPO, "first Claude conversation"),
      ),
      writeClaude(
        "-Users-dev-work-Personal-Project-nomoreide",
        "claude-two",
        claudeSession("claude-two", REPO, "second Claude conversation"),
      ),
      ...Array.from({ length: 101 }, (_, index) =>
        writeCodex(
          ["2026", "07", "20"],
          `codex-${index}`,
          REPO,
          `Codex conversation ${index}`,
        ),
      ),
    ]);

    const rows = await listAgentTranscripts({ repoPath: REPO, homeDir: home });

    expect(rows.filter((row) => row.provider === "claude")).toHaveLength(2);
    expect(rows.filter((row) => row.provider === "codex")).toHaveLength(100);
  });

  test("returns nothing when neither CLI has been used", async () => {
    expect(await listAgentTranscripts({ repoPath: REPO, homeDir: home })).toEqual([]);
  });
});
