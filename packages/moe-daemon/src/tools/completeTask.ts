import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns, assertAllStepsCompleted, assertVerificationEvidence } from '../util/enforcement.js';

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
