import { useCallback, useEffect, useRef, useState } from "react";
import {
  getGitStatus,
  gitCommit,
  gitPush,
  gitStage,
  type GitFileStatus,
  type Workflow,
  type WorkflowStep,
} from "@/lib/api";
import { useAgentDock } from "../agent/chat/agent-context";
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
 * - **agent** → hands the step to the dock conversation via `sendToAgent`, waits
 *   for that turn to finish, then (optionally) verifies the real git state
 *   before advancing. The agent does the work *in the dock* — the panel just
 *   shows where we are.
 * - **gate** → stops and waits for the human (Approve / Skip / Stop).
 *
 * Agent turns are tracked via the dock's `streaming` flag: we wait for it to go
 * idle, with a grace timeout so a turn that never starts (agent not installed)
 * doesn't hang the run.
 */
export function useWorkflowRunner(onRefresh?: () => void) {
  const { sendToAgent, streaming, turns } = useAgentDock();
  const [run, setRun] = useState<RunState | null>(null);

  // Always-fresh view of the dock transcript so the loop can grab a finished
  // agent turn's text as that step's result.
  const turnsRef = useRef(turns);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const gateRef = useRef<((decision: GateDecision) => void) | null>(null);
  const idleRef = useRef<(() => void) | null>(null);
  const sawStreamingRef = useRef(false);

  // Resolve an in-flight agent step the moment the dock turn finishes streaming.
  useEffect(() => {
    if (streaming) {
      sawStreamingRef.current = true;
    } else if (sawStreamingRef.current && idleRef.current) {
      const resolve = idleRef.current;
      idleRef.current = null;
      resolve();
    }
  }, [streaming]);

  const waitForGate = useCallback(
    () => new Promise<GateDecision>((resolve) => {
      gateRef.current = resolve;
    }),
    [],
  );

  const waitForAgentTurn = useCallback(
    () => new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        idleRef.current = null;
        resolve();
      };
      idleRef.current = finish;
      // If the turn never even begins streaming (e.g. agent not configured),
      // don't wait forever — verification will catch a no-op.
      const timer = setTimeout(() => {
        if (!sawStreamingRef.current) finish();
      }, 8000);
    }),
    [],
  );

  const verify = useCallback(async (kind: "committed" | "pushed"): Promise<boolean> => {
    const status = await getGitStatus();
    if (kind === "committed") return status.files.length === 0;
    if (kind === "pushed") return status.ahead === 0;
    return true;
  }, []);

  const runAction = useCallback(async (step: Extract<WorkflowStep, { kind: "action" }>) => {
    if (step.op === "push") {
      await gitPush();
      return;
    }
    if (step.op === "commit") {
      // Deterministic, zero-token commit: stage everything and commit with a
      // generated message. No diff reading, no quality analysis — just commit.
      const status = await getGitStatus();
      const paths = status.files.map((file) => file.path);
      if (!paths.length) throw new Error("Nothing to commit — the working tree is clean.");
      await gitStage(paths);
      await gitCommit(generateCommitMessage(status.files));
      return;
    }
    throw new Error(`Unknown action: ${step.op}`);
  }, []);

  const start = useCallback(
    async (workflow: Workflow, autoApprove = false) => {
      if (busyRef.current) return;
      busyRef.current = true;
      stopRef.current = false;

      const statuses: StepStatus[] = workflow.steps.map(() => "pending");
      const outputs: string[] = workflow.steps.map(() => "");
      const patch = (index: number, status: StepStatus, extra?: Partial<RunState>) => {
        statuses[index] = status;
        setRun((prev) =>
          prev ? { ...prev, index, statuses: [...statuses], outputs: [...outputs], ...extra } : prev,
        );
      };

      setRun({
        workflow,
        index: 0,
        statuses: [...statuses],
        outputs: [...outputs],
        error: null,
        outcome: "running",
      });

      const halt = (outcome: RunOutcome) => {
        busyRef.current = false;
        setRun((prev) => (prev ? { ...prev, outcome } : prev));
      };

      for (let i = 0; i < workflow.steps.length; i++) {
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
            await runAction(step);
            patch(i, "done");
            onRefresh?.();
          } catch (caught) {
            patch(i, "failed", { error: messageOf(caught) });
            halt("failed");
            return;
          }
          if (stopRef.current) return halt("stopped");
          continue;
        }

        // Agent step — runs in the dock conversation.
        patch(i, "running");
        sawStreamingRef.current = false;
        sendToAgent({
          prompt: step.prompt + STATUS_HINT,
          source: { type: "workflow", label: `${workflow.name}: ${step.title}` },
          mode: "send",
          label: step.title,
          autoApprove,
          background: true,
        });
        await waitForAgentTurn();
        onRefresh?.();
        // Read the agent's reply: capture it as the step result, and decide
        // whether it actually succeeded — don't just assume a finished turn means
        // success. A blocked / question reply pauses the run for the user.
        const result = readStepResult(latestAssistantText(turnsRef.current));
        outputs[i] = result.output || "(no reply — see the dock)";
        if (result.blocked) {
          patch(i, "blocked", {
            error: result.reason
              ? `Paused — ${result.reason}`
              : "Paused — this step needs your input. Open the dock to reply, then re-run.",
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
    [onRefresh, runAction, sendToAgent, verify, waitForAgentTurn, waitForGate],
  );

  const approve = useCallback(() => gateRef.current?.("approve"), []);
  const skip = useCallback(() => gateRef.current?.("skip"), []);
  const stop = useCallback(() => {
    stopRef.current = true;
    gateRef.current?.("stop");
  }, []);
  const dismiss = useCallback(() => {
    if (busyRef.current) return; // don't clear a live run
    setRun(null);
  }, []);

  return { run, start, approve, skip, stop, dismiss, isRunning: !!run && run.outcome === "running" };
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** The most recent assistant reply in the transcript — a finished step's result. */
function latestAssistantText(turns: ReadonlyArray<{ role: string; text: string }>): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") return turns[i].text.trim();
  }
  return "";
}

/**
 * A free, deterministic commit message from the changed-file list — no agent,
 * no diff. Names up to three files, then summarizes the rest by count. Quality
 * isn't the goal here; getting the commit made cheaply is.
 */
function generateCommitMessage(files: GitFileStatus[]): string {
  const names = files.map((file) => file.path.split("/").pop() || file.path);
  if (names.length === 1) return `Update ${names[0]}`;
  if (names.length <= 3) return `Update ${names.join(", ")}`;
  return `Update ${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}
