import { useCallback, useEffect, useRef, useState } from "react";
import {
  getGitStatus,
  gitCheckoutDefaultAndPull,
  gitCommit,
  gitPush,
  gitStage,
  type GitFileStatus,
  type GitStatusSummary,
  type Workflow,
  type WorkflowStep,
} from "@/lib/api";
import { useAgentDock } from "../agent/chat/agent-context";
import { runHeadlessAgentTask } from "../agent/headless/run-headless-agent-task";
import { buildAgentWorkflowPrompt } from "./workflow-prompts";
import { readStepResult } from "./workflow-result";

export type StepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "skipped"
  /** The agent couldn't complete the step or is asking for input — the run pauses. */
  | "blocked";

export type RunOutcome = "running" | "done" | "stopped" | "failed" | "blocked";

/**
 * Appended to every agent step so the agent reports whether it actually finished.
 * The runner reads the marker (and falls back to phrase detection) instead of
 * assuming a finished turn means success.
 */
const STATUS_HINT =
  "\n\nWhen you're finished, end your reply with a line that's exactly `WORKFLOW_STATUS: ok` if you completed this step, or `WORKFLOW_STATUS: blocked` followed by a short reason if you could NOT complete it or you need my input. The workflow runner reads this line.";

export interface RunState {
  workflow: Workflow;
  /** When this retained run started, used by the workflow list to show recency. */
  startedAt: number;
  /** Set when the retained run reaches a terminal outcome. */
  endedAt?: number;
  /** Index of the step currently being processed. */
  index: number;
  statuses: StepStatus[];
  /** The agent's reply text for each step (the step's "result"), once it ran. */
  outputs: string[];
  error: string | null;
  outcome: RunOutcome;
}

type GateDecision = "approve" | "skip" | "stop";

/**
 * Client-side orchestrator for a {@link Workflow}. It walks the steps one at a
 * time:
 *
 * - **action** → calls the REST API and trusts its result.
 * - **agent** → runs the step in a fresh headless agent session, reads its
 *   explicit result, then optionally verifies real git state before advancing.
 * - **gate** → stops and waits for the human (Approve / Skip / Stop).
 *
 */
export function useWorkflowRunner(onRefresh?: () => void) {
  const { provider } = useAgentDock();
  const [run, setRun] = useState<RunState | null>(null);

  // Always-fresh view of the run so `resume` can read where a paused run stopped
  // without re-binding the callback on every status patch.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const gateRef = useRef<((decision: GateDecision) => void) | null>(null);
  const headlessAbortRef = useRef<AbortController | null>(null);

  const waitForGate = useCallback(
    () => new Promise<GateDecision>((resolve) => {
      gateRef.current = resolve;
    }),
    [],
  );

  const verify = useCallback(async (kind: "committed" | "pushed"): Promise<boolean> => {
    const status = await getGitStatus();
    if (kind === "committed") return status.files.length === 0;
    if (kind === "pushed") return status.ahead === 0;
    return true;
  }, []);

  const runAction = useCallback(async (
    step: Extract<WorkflowStep, { kind: "action" }>,
    index: number,
    outputs: string[],
  ) => {
    if (step.op === "assert-pr-branch") {
      assertPullRequestBranch(await getGitStatus());
      return;
    }
    if (step.op === "push") {
      await gitPush();
      return;
    }
    if (step.op === "checkout-default-and-pull") {
      await gitCheckoutDefaultAndPull();
      return;
    }
    if (step.op === "commit") {
      // Deterministic, zero-token commit: stage everything and commit with a
      // generated message. No diff reading, no quality analysis — just commit.
      const status = await getGitStatus();
      if (!status.files.length) throw new Error("Nothing to commit — the working tree is clean.");
      const paths = pathsToStageForCommitAction(status.files);
      if (paths.length) await gitStage(paths);
      await gitCommit(messageForCommitAction(outputs, index, status.files));
      return;
    }
    throw new Error(`Unknown action: ${step.op}`);
  }, []);

  // Runs a workflow from `resumeFrom.index` (or 0 for a fresh start), seeding the
  // already-completed steps' statuses/outputs so a resumed run continues the
  // pipeline instead of redoing the steps you already passed.
  const execute = useCallback(
    async (
      workflow: Workflow,
      autoApprove: boolean,
      resumeFrom?: { index: number; statuses: StepStatus[]; outputs: string[]; startedAt: number },
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      stopRef.current = false;

      const startIndex = resumeFrom?.index ?? 0;
      // Keep finished steps (before the resume point) as-is; reset the rest to
      // pending so the retried step and everything after it run cleanly.
      const statuses: StepStatus[] = workflow.steps.map((_, i) =>
        resumeFrom && i < startIndex ? resumeFrom.statuses[i] ?? "pending" : "pending",
      );
      const outputs: string[] = workflow.steps.map((_, i) => resumeFrom?.outputs[i] ?? "");
      const patch = (index: number, status: StepStatus, extra?: Partial<RunState>) => {
        statuses[index] = status;
        setRun((prev) =>
          prev ? { ...prev, index, statuses: [...statuses], outputs: [...outputs], ...extra } : prev,
        );
      };

      setRun({
        workflow,
        startedAt: resumeFrom?.startedAt ?? Date.now(),
        index: startIndex,
        statuses: [...statuses],
        outputs: [...outputs],
        error: null,
        outcome: "running",
      });

      const halt = (outcome: RunOutcome) => {
        busyRef.current = false;
        setRun((prev) => (prev ? { ...prev, outcome, endedAt: Date.now() } : prev));
      };

      for (let i = startIndex; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];

        if (step.kind === "gate") {
          patch(i, "waiting");
          const decision = await waitForGate();
          gateRef.current = null;
          if (decision === "stop") {
            patch(i, "skipped");
            halt("stopped");
            return;
          }
          patch(i, decision === "skip" ? "skipped" : "done");
          continue;
        }

        if (step.kind === "action") {
          patch(i, "running");
          try {
            await runAction(step, i, outputs);
            patch(i, "done");
            onRefresh?.();
          } catch (caught) {
            if (step.op === "assert-pr-branch") {
              patch(i, "blocked", { error: messageOf(caught) });
              halt("blocked");
              return;
            }
            patch(i, "failed", { error: messageOf(caught) });
            halt("failed");
            return;
          }
          if (stopRef.current) return halt("stopped");
          continue;
        }

        // Agent step — runs in a fresh, result-bearing headless session.
        patch(i, "running");
        const controller = new AbortController();
        headlessAbortRef.current = controller;
        let agentText: string;
        try {
          agentText = await runHeadlessAgentTask({
            prompt: buildAgentWorkflowPrompt(step) + STATUS_HINT,
            provider: provider?.id,
            autoApprove,
            signal: controller.signal,
          });
        } catch (caught) {
          headlessAbortRef.current = null;
          if (stopRef.current || controller.signal.aborted) {
            halt("stopped");
            return;
          }
          patch(i, "failed", { error: messageOf(caught) });
          halt("failed");
          return;
        }
        headlessAbortRef.current = null;
        onRefresh?.();
        const result = readStepResult(agentText);
        outputs[i] = result.output || "(no reply from agent)";
        if (result.blocked) {
          patch(i, "blocked", {
            error: result.reason
              ? `Paused — ${result.reason} Fix it (Debug with AI in the dock if you like), then Resume workflow to retry this step.`
              : "Paused — this step needs your input. Fix it (Debug with AI in the dock if you like), then Resume workflow to retry this step.",
          });
          halt("blocked");
          return;
        }

        if (step.verify) {
          const ok = await verify(step.verify).catch(() => false);
          if (!ok) {
            patch(i, "failed", {
              error:
                step.verify === "committed"
                  ? "Expected the working tree to be clean after this step, but it isn't. Stopping before the next step."
                  : "Expected the branch to be pushed (no commits ahead), but it isn't. Stopping.",
            });
            halt("failed");
            return;
          }
        }
        patch(i, "done");
        if (stopRef.current) return halt("stopped");
      }

      halt("done");
    },
    [onRefresh, provider?.id, runAction, verify, waitForGate],
  );

  const start = useCallback(
    (workflow: Workflow, autoApprove = false) => execute(workflow, autoApprove),
    [execute],
  );

  // Pick a paused (blocked/failed) run back up from the step it stopped on —
  // after you've fixed the small thing (often via "Debug with AI" in the dock),
  // this retries that step and continues the rest of the pipeline.
  const resume = useCallback(
    (autoApprove = false) => {
      const prev = runRef.current;
      if (!prev || prev.outcome === "running" || busyRef.current) return;
      void execute(prev.workflow, autoApprove, {
        index: prev.index,
        statuses: prev.statuses,
        outputs: prev.outputs,
        startedAt: prev.startedAt,
      });
    },
    [execute],
  );

  const approve = useCallback(() => gateRef.current?.("approve"), []);
  const skip = useCallback(() => gateRef.current?.("skip"), []);
  const stop = useCallback(() => {
    stopRef.current = true;
    headlessAbortRef.current?.abort();
    gateRef.current?.("stop");
  }, []);
  const dismiss = useCallback(() => {
    if (busyRef.current) return; // don't clear a live run
    setRun(null);
  }, []);

  return { run, start, resume, approve, skip, stop, dismiss, isRunning: !!run && run.outcome === "running" };
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * A free, deterministic commit message from the changed-file list — no agent,
 * no diff. Names up to three files, then summarizes the rest by count. Quality
 * isn't the goal here; getting the commit made cheaply is.
 */
export function messageForCommitAction(
  outputs: string[],
  index: number,
  files: GitFileStatus[],
): string {
  const previous = outputs[index - 1]?.trim();
  return previous || generateCommitMessage(files);
}

export function pathsToStageForCommitAction(files: GitFileStatus[]): string[] {
  const hasStagedChanges = files.some((file) => file.index.trim() && file.index !== "?");
  return hasStagedChanges ? [] : files.map((file) => file.path);
}

export function assertPullRequestBranch(status: GitStatusSummary): void {
  const branch = status.branch.trim();
  if (!branch) {
    throw new Error("Create or switch to a feature branch before opening a PR — detached HEAD cannot be used as a PR branch.");
  }
  if (!isDefaultBranchName(branch)) return;

  const hasLocalChanges = status.files.length > 0;
  const nextStep = hasLocalChanges
    ? "Create or switch to a feature branch before committing these changes."
    : "Pull the default branch if needed, then create or switch to a feature branch.";
  throw new Error(
    `Create or switch to a feature branch before opening a PR. Current branch is ${branch}. ${nextStep}`,
  );
}

function isDefaultBranchName(branch: string): boolean {
  return branch === "main" || branch === "master";
}

function generateCommitMessage(files: GitFileStatus[]): string {
  const names = files.map((file) => file.path.split("/").pop() || file.path);
  if (names.length === 1) return `Update ${names[0]}`;
  if (names.length <= 3) return `Update ${names.join(", ")}`;
  return `Update ${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}
