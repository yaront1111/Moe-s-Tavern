import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { MoeError, MoeErrorCode, notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns, assertAllStepsCompleted, assertVerificationEvidence } from '../util/enforcement.js';
import { describeBranchPolicyFailure, matchesBranchPattern } from '../util/branchPolicy.js';
import { currentAttempt, setAttemptPhase } from '../state/attemptStore.js';
import type { ExecutionAttempt } from '../types/schema.js';

interface BranchPolicyOutcome {
  pattern: string;
  currentBranch?: string;
  matched: boolean | null;
  warning?: string;
}

/**
 * Enforce `settings.consolidationBranch` for one completion.
 *
 * Returns null when no policy is configured (unconfigured projects are wholly
 * unaffected), throws on a real mismatch, and only WARNS when the caller
 * reported no branch — the agent wrappers do not send `currentBranch` yet, so
 * blocking on its absence would break every completion on rollout.
 */
async function checkBranchPolicy(
  state: StateManager,
  taskId: string,
  currentBranch?: string
): Promise<BranchPolicyOutcome | null> {
  // A hand-edited project.json bypasses validateSettingsUpdate, so the type
  // guard here is the real error handling — a non-string setting must disable
  // the check, not throw out of complete_task.
  const configured = state.project?.settings?.consolidationBranch;
  const pattern = typeof configured === 'string' ? configured.trim() : '';
  if (!pattern) return null;

  const branch = typeof currentBranch === 'string' ? currentBranch.trim() : '';
  if (!branch) {
    const warning = 'currentBranch not reported — branch policy not enforced for this completion';
    try {
      await state.postToRoleChannel(
        'governors',
        `⚠️ Branch policy not enforced on ${taskId}: no currentBranch reported (expected "${pattern}").`
      );
    } catch { /* never block a completion on a chat post */ }
    return { pattern, matched: null, warning };
  }

  if (!matchesBranchPattern(branch, pattern)) {
    throw new MoeError(
      MoeErrorCode.CONSTRAINT_VIOLATION,
      `BRANCH-POLICY-FAIL: ${describeBranchPolicyFailure(branch, pattern)}`,
      { currentBranch: branch, expectedPattern: pattern },
      'CONSTRAINT_VIOLATION'
    );
  }

  return { pattern, currentBranch: branch, matched: true };
}

export function completeTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.complete_task',
    description: 'Mark a task as complete (move to REVIEW). Requires verification evidence from a fresh run of the plan\'s verification command.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        verification: {
          type: 'object',
          description: 'Evidence the verification command was run fresh and passed. exitCode must be 0.',
          properties: {
            command: { type: 'string', description: 'The exact verification command that was run (the one the plan named)' },
            exitCode: { type: 'number', description: 'Its exit code — must be 0' },
            outputTail: { type: 'string', description: 'Tail of its output (last ~2000 chars), e.g. the test-run summary line' }
          },
          required: ['command', 'exitCode'],
          additionalProperties: false
        },
        prLink: { type: 'string' },
        summary: { type: 'string', description: 'What was delivered — persisted as task.completionSummary (capped at 2000 chars) and surfaced to QA and dependent tasks via get_context.' },
        currentBranch: { type: 'string', description: 'Branch the worker is on; enables the consolidationBranch policy check' },
        workerId: { type: 'string' }
      },
      required: ['taskId', 'verification'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as {
        taskId: string;
        verification?: { command?: string; exitCode?: number; outputTail?: string };
        prLink?: string;
        summary?: string;
        currentBranch?: string;
        workerId?: string;
      };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }
      assertWorkerOwns(task, params.workerId);
      assertAllStepsCompleted(task);
      const verification = assertVerificationEvidence(params.verification);
      // Runs with the other assertions, BEFORE updateTask: a rejection must
      // leave the task untouched in WORKING rather than half-completed.
      const branchPolicy = await checkBranchPolicy(state, task.id, params.currentBranch);

      // Capture the worker to IDLE *after* the task update so a failed updateTask
      // doesn't leave the worker idle while the task is still WORKING (half-applied state).
      const handoffWorkerId = task.assignedWorkerId || params.workerId;

      const now = new Date().toISOString();
      // Aggregate the changed-file set before the update so it can be persisted
      // for QA (per-step modifiedFiles are worker-volunteered and easy to miss).
      const planSteps = task.implementationPlan || [];
      const filesModified = Array.from(new Set(
        planSteps
          .filter((s) => s.status === 'COMPLETED')
          .flatMap((s) => s.modifiedFiles || s.affectedFiles || [])
      ));
      // The summary used to be accepted and silently DISCARDED — persist it
      // (capped like qa_approve's reviewSummary; truncated, never rejected, so
      // an over-long summary can't fail an otherwise-valid completion).
      const completionSummary =
        typeof params.summary === 'string' && params.summary.trim().length > 0
          ? params.summary.trim().slice(0, 2000)
          : undefined;

      // Hold the owning attempt OPEN in `finalizing` BEFORE the REVIEW
      // transition, never after it. That single updateTask is what frees the
      // worker — it clears assignedWorkerId on the WORKING -> REVIEW handoff —
      // so an attempt still in phase `running` at that instant is exactly the
      // window in which a session starts task B while task A's bytes are still
      // unlanded (the wrapper only lands them after the CLI exits).
      //
      // Going FIRST is deliberate: a later failure then leaves a conservatively
      // `finalizing` attempt on a still-WORKING task, which blocks only this
      // worker's own next claim and is repaired by its own retry. The opposite
      // order would leave a freed worker holding a `running` attempt, which is
      // the defect itself. This is NOT a cross-entity transaction and promises
      // no rollback: the attempt write and the task write can diverge, and the
      // direction they diverge in is chosen to fail safe.
      //
      // Never `closed` here — closed is terminal in the store, so closing would
      // hand the seat straight back and silently restore the old behaviour.
      // A task with no attempt is a legacy row predating attempts entirely:
      // currentAttempt returns null and the completion proceeds untouched.
      const openAttempt = currentAttempt(state, task.id);
      const finalizing: ExecutionAttempt | null = openAttempt
        ? await setAttemptPhase(state, openAttempt.id, 'finalizing')
        : null;

      // Stamp reviewStartedAt only. completedAt means "finished" and is stamped
      // at DONE by qa_approve — not here at REVIEW entry (that was a misnomer).
      const updated = await state.updateTask(
        task.id,
        {
          status: 'REVIEW',
          prLink: params.prLink || task.prLink,
          reviewStartedAt: now,
          // The label goes AFTER the spread: this is the agent's own attestation,
          // and nothing a caller sends may relabel it runner-observed.
          verification: { ...verification, reportedAt: now, source: 'agent-reported' },
          filesModified,
          ...(completionSummary ? { completionSummary } : {}),
        },
        'TASK_COMPLETED'
      );

      // updateTask clears assignedWorkerId on WORKING -> REVIEW handoff; touchWorker
      // skips missing worker records and never blocks a successfully completed task.
      await state.touchWorker(handoffWorkerId, { status: 'IDLE', currentTaskId: null });

      if (params.prLink) {
        state.appendActivity('PR_OPENED', { prLink: params.prLink }, updated);
      }

      // Post system message to task channel
      try {
        await state.postSystemMessage(task.id, 'Task submitted for review');
      } catch { /* never block tool */ }

      // Safely handle implementationPlan which could be null/undefined or empty
      const implementationPlan = updated.implementationPlan || [];
      const completedSteps = implementationPlan.filter((s) => s.status === 'COMPLETED');

      return {
        success: true,
        taskId: updated.id,
        status: 'REVIEW',
        ...(completionSummary ? { completionSummary } : {}),
        stats: {
          stepsCompleted: completedSteps.length,
          totalSteps: implementationPlan.length,
          filesModified,
          duration: 'n/a'
        },
        ...(branchPolicy ? { branchPolicy } : {}),
        // Beside the stats, with the same flat key names the claim result uses.
        ...(finalizing ? { attemptId: finalizing.id, generation: finalizing.generation } : {}),
        // While an attempt of this worker is finalizing, the hint must name NO
        // tool at all: every claim/wait tool is an invitation to start the next
        // task across an artifact boundary that is still open, and a claim from
        // this worker is refused until the boundary is acknowledged anyway. A
        // legacy row with no attempt opened no boundary, so it keeps the old
        // hint unchanged.
        nextAction: finalizing
          ? {
              reason:
                `Task handed to QA, but attempt ${finalizing.id} (generation ${finalizing.generation}) is ` +
                'FINALIZING: your bytes are NOT landed until this session exits and the wrapper commits them. ' +
                'Record a Serena write_memory `task-' + updated.id + '-handoff` note (and any gotcha-<area> ' +
                'learnings) for the next agent, then END YOUR TURN. Do not claim or wait for another task — ' +
                'a claim from you is refused while this attempt is finalizing.'
            }
          : {
              tool: 'moe.wait_for_task',
              args: {
                statuses: ['WORKING'],
                workerId: params.workerId,
              },
              reason: 'Task handed to QA. Record a Serena write_memory `task-' + updated.id + '-handoff` note (and any gotcha-<area> learnings) for the next agent, then block until the next task arrives.'
            }
      };
    }
  };
}
