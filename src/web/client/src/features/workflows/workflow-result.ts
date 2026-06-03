/**
 * Decides whether an agent workflow step actually succeeded from its reply text,
 * so the runner doesn't treat a finished turn as success when the agent really
 * refused or asked a question. Kept pure (no React) so it's unit-testable.
 */

const STATUS_MARKER = /^[ \t>*_-]*WORKFLOW_STATUS:\s*(ok|blocked)\b[ \t]*[—–:-]?[ \t]*(.*)$/im;

export interface StepResult {
  /** The reply with the status-marker line stripped — what the user sees. */
  output: string;
  /** True when the step did not complete / needs the user. */
  blocked: boolean;
  /** Short reason, when the agent gave one on a blocked marker. */
  reason?: string;
}

/**
 * Prefers the explicit `WORKFLOW_STATUS:` marker the runner asks the agent to
 * emit; if it's missing, falls back to detecting refusal / question phrasing.
 */
export function readStepResult(raw: string): StepResult {
  const match = raw.match(STATUS_MARKER);
  if (match) {
    const blocked = match[1].toLowerCase() === "blocked";
    const reason = match[2]?.trim() || undefined;
    return {
      output: raw.replace(STATUS_MARKER, "").trim(),
      blocked,
      reason: blocked ? reason : undefined,
    };
  }
  return { output: raw, blocked: looksBlocked(raw) };
}

/** Heuristic backup for when the agent omits the status marker. */
export function looksBlocked(text: string): boolean {
  return /\bi can'?t\b|\bcannot\b|\bunable\b|\bnot able\b|\bwon'?t\b|\bwant me to\b|\bdid you mean\b|\bshould i\b|\bneed (?:you|your|more)\b|\binstead of merging\b/i.test(
    text,
  );
}
