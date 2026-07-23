import { invalidInput } from './errors.js';

/**
 * The only columns agents claim from: architects claim PLANNING, workers claim
 * WORKING, QA claims REVIEW — matching the launcher status maps in
 * scripts/moe-agent.{ps1,sh}. Every other column is human-gated and has NO
 * agent tool surface (start_step/submit_plan/qa_* all demand one of these
 * three), so a claim outside this set can only produce a wedged worker: the
 * assignment succeeds, the status never transitions, every action tool rejects
 * with INVALID_STATE, and one-task-per-worker blocks claiming anything else.
 */
export const AGENT_CLAIMABLE_STATUSES = ['PLANNING', 'WORKING', 'REVIEW'] as const;

/** Throws invalidInput if any requested status is outside the agent-claimable set. */
export function assertAgentClaimableStatuses(statuses: string[]): void {
  const invalid = statuses.filter(
    (s) => !(AGENT_CLAIMABLE_STATUSES as readonly string[]).includes(s)
  );
  if (invalid.length === 0) return;
  throw invalidInput(
    'statuses',
    `${invalid.join(', ')} is not agent-claimable. Agents claim only PLANNING (architect), ` +
      `WORKING (worker), or REVIEW (qa). BACKLOG, AWAITING_APPROVAL, DONE and ARCHIVED are ` +
      `human-gated columns with no agent tool surface — claiming there wedges the worker ` +
      `(start_step/submit_plan/qa_* all reject with INVALID_STATE). Ask a human or governor ` +
      `to route the task with moe.set_task_status instead.`
  );
}
