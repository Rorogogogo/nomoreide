import { z } from "zod";

const workflowCapabilitiesSchema = z.object({
  skills: z.array(z.string().min(1)).optional(),
  mcpServers: z.array(z.string().min(1)).optional(),
  plugins: z.array(z.string().min(1)).optional(),
  hooks: z.array(z.string().min(1)).optional(),
});

/**
 * User-owned git/GitHub workflows — the AI-native answer to fixed IDE buttons.
 *
 * A workflow is an ordered list of steps the runner walks one at a time. A step
 * is one of three kinds:
 *
 * - **action** — deterministic, no inputs needed (e.g. `push`). Runs via the
 *   REST API and its result tells us pass/fail. Predictable, no tokens spent.
 * - **agent** — a scoped natural-language task handed to the dock agent, which
 *   does the fuzzy work (review a diff, group commits, draft + file a PR/issue)
 *   using its own git/GitHub tools. Optionally `verify`-d against real git state.
 * - **gate** — a hard stop that waits for the human (Approve / Skip / Stop).
 *
 * The runner itself lives client-side (agent steps execute through the dock
 * conversation); this module owns the *shape* and the built-in templates, and is
 * persisted through {@link ConfigStore} so a user can fork/edit them later.
 */

export const workflowStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action"),
    id: z.string().min(1),
    title: z.string().min(1),
    /**
     * Deterministic op with no inputs — runs straight through the REST API with
     * zero agent tokens. `commit` stages everything and commits with a generated
     * message (no diff reading, no quality analysis); `push` pushes the branch.
     */
    op: z.enum(["push", "commit"]),
  }),
  z.object({
    kind: z.literal("agent"),
    id: z.string().min(1),
    title: z.string().min(1),
    /** The instruction handed to the dock agent. */
    prompt: z.string().min(1),
    /** Optional user-selected capabilities the runner adds as prompt guidance. */
    capabilities: workflowCapabilitiesSchema.optional(),
    /**
     * Real-state check run after the agent's turn before advancing:
     * - `committed` — the working tree is clean (changes were committed).
     * - `pushed` — the branch is no longer ahead of its upstream.
     */
    verify: z.enum(["committed", "pushed"]).optional(),
  }),
  z.object({
    kind: z.literal("gate"),
    id: z.string().min(1),
    title: z.string().min(1),
    /** Shown at the pause so the user knows what they're approving. */
    message: z.string().min(1),
  }),
]);

export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  /** True for the shipped templates; false/absent for user-saved workflows. */
  builtin: z.boolean().optional(),
  steps: z.array(workflowStepSchema).min(1),
});

export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type Workflow = z.infer<typeof workflowSchema>;

const COMMIT_GATE: WorkflowStep = {
  kind: "gate",
  id: "gate-commit",
  title: "Approve commit",
  message: "Stage the current changes and create one AI-written commit?",
};

/**
 * One lightweight AI pass that writes a real commit message and commits — the
 * balance the user wanted: a thought-through message like the `commit-push`
 * skill, but a single pass (no review report, no splitting into many commits).
 * Shared by the commit-bearing templates.
 */
const COMMIT_STEP: WorkflowStep = {
  kind: "agent",
  id: "commit",
  title: "Commit all changes",
  prompt:
    "Stage my changes and make ONE commit, in a single pass. Steps: stage the changed files with `nomoreide_git_stage` (skip anything that looks like a secret, e.g. `.env`); glance at the staged diff once with `nomoreide_git_staged_diff`; then commit with `nomoreide_git_commit` using a conventional-commit message — a `<type>: concise title` line (feat/fix/refactor/chore/docs/test) plus a few short bullets of what changed. One commit only: do NOT split into multiple commits and do NOT write a separate review or analysis. Reply with just the commit message you used.",
  verify: "committed",
};

/**
 * The Phase-1 starter set. These are plain data (not hardcoded UI), so the same
 * structure a user authors later can be forked from one of these.
 */
export const BUILTIN_WORKFLOWS: Workflow[] = [
  {
    id: "commit-push",
    name: "Commit & push",
    description: "Pause for approval, make one AI-written commit, then pause again before pushing.",
    builtin: true,
    steps: [
      { ...COMMIT_GATE },
      COMMIT_STEP,
      { kind: "gate", id: "gate-push", title: "Approve push", message: "Push to the remote?" },
      { kind: "action", id: "push", title: "Push", op: "push" },
    ],
  },
  {
    id: "ship-it",
    name: "Ship it",
    description: "Approve the AI commit, push, then use quick AI turns to open and squash-merge the PR.",
    builtin: true,
    steps: [
      { ...COMMIT_GATE },
      COMMIT_STEP,
      { kind: "gate", id: "gate-push", title: "Approve push", message: "Push and open a PR?" },
      { kind: "action", id: "push", title: "Push", op: "push" },
      {
        kind: "agent",
        id: "open-pr",
        title: "Open a PR",
        prompt:
          "Open a PR for the current branch into `main` using the `nomoreide_github_create_pr` tool. Title = the latest commit subject; for the body, list the commits via `nomoreide_git_log`. Do NOT read file diffs. Reply with just the PR number and URL.",
      },
      { kind: "gate", id: "gate-merge", title: "Approve merge", message: "Squash-merge the pull request?" },
      {
        kind: "agent",
        id: "merge",
        title: "Squash-merge",
        prompt:
          "Squash-merge the PR you just opened with the `nomoreide_github_merge_pr` tool. Don't analyze anything — just merge. Reply with one line.",
      },
    ],
  },
  {
    id: "file-issue",
    name: "File an issue from these changes",
    description: "One quick AI turn drafts a short issue from your file list, then files it on approval.",
    builtin: true,
    steps: [
      {
        kind: "agent",
        id: "draft",
        title: "Draft a short issue",
        prompt:
          "Draft a SHORT GitHub issue (a title + a 2–3 line body) from the list of changed files only — call `nomoreide_git_status` for the file list. Do NOT read file diffs or analyze the changes. Show me the draft; don't file it.",
      },
      { kind: "gate", id: "gate-file", title: "Approve filing", message: "File this issue on GitHub?" },
      {
        kind: "agent",
        id: "create",
        title: "File the issue",
        prompt:
          "Create the GitHub issue you just drafted using the `nomoreide_github_create_issue` tool. Reply with just the issue number and URL.",
      },
    ],
  },
];

/**
 * Merge the built-in templates with the user's saved workflows. A stored
 * workflow whose id matches a built-in *replaces* it (that's a fork/edit);
 * everything else is appended. Built-ins come first.
 */
export function listWorkflows(stored: Workflow[]): Workflow[] {
  const overrides = new Map(stored.map((workflow) => [workflow.id, workflow]));
  const merged = BUILTIN_WORKFLOWS.map((builtin) => overrides.get(builtin.id) ?? builtin);
  const extras = stored.filter((workflow) => !BUILTIN_WORKFLOWS.some((b) => b.id === workflow.id));
  return [...merged, ...extras];
}
