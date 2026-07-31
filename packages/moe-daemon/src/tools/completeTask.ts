import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { MoeError, MoeErrorCode, notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns, assertAllStepsCompleted, assertVerificationEvidence } from '../util/enforcement.js';
import { describeBranchPolicyFailure, matchesBranchPattern } from '../util/branchPolicy.js';

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
        summary: { type: 'string' },
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
      // Stamp reviewStartedAt only. completedAt means "finished" and is stamped
      // at DONE by qa_approve — not here at REVIEW entry (that was a misnomer).
      const updated = await state.updateTask(
        task.id,
        {
          status: 'REVIEW',
          prLink: params.prLink || task.prLink,
          reviewStartedAt: now,
          verification: { ...verification, reportedAt: now },
          filesModified,
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
        stats: {
          stepsCompleted: completedSteps.length,
          totalSteps: implementationPlan.length,
          filesModified,
          duration: 'n/a'
        },
        ...(branchPolicy ? { branchPolicy } : {}),
        nextAction: {
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
