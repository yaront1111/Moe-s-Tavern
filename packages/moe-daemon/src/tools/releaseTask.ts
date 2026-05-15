import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { HandoffNote } from '../types/schema.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';

const MAX_HANDOFFS_PER_TASK = 20;
const MAX_HANDOFF_FIELD_LEN = 4000;

function clampField(value: unknown, field: string, max = MAX_HANDOFF_FIELD_LEN): string {
  if (typeof value !== 'string') {
    throw invalidInput(`handoffNote.${field}`, 'must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw invalidInput(`handoffNote.${field}`, 'cannot be empty');
  }
  return trimmed.slice(0, max);
}

function clampOptional(value: unknown, field: string, max = MAX_HANDOFF_FIELD_LEN): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw invalidInput(`handoffNote.${field}`, 'must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

export function releaseTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.release_task',
    description: 'Release a task from its assigned worker (clears assignedWorkerId, status unchanged). Anyone can call.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task to release' },
        reason: { type: 'string', description: 'Optional human-readable reason' },
        handoffNote: {
          type: 'object',
          description: 'Structured note describing what was done and what remains; surfaced to the next claimer via moe.get_handoff_history.',
          properties: {
            whatIsDone: { type: 'string' },
            whatRemains: { type: 'string' },
            pitfalls: { type: 'string' },
            openQuestions: { type: 'string' }
          },
          required: ['whatIsDone', 'whatRemains'],
          additionalProperties: false
        },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        reason?: string;
        handoffNote?: {
          whatIsDone?: unknown;
          whatRemains?: unknown;
          pitfalls?: unknown;
          openQuestions?: unknown;
        };
        workerId?: string;
      };
      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      // Validate handoff shape BEFORE acquiring the state mutex so we don't
      // hold the lock while throwing on bad input.
      let normalizedHandoff: HandoffNote | null = null;
      if (params.handoffNote) {
        normalizedHandoff = {
          whatIsDone: clampField(params.handoffNote.whatIsDone, 'whatIsDone'),
          whatRemains: clampField(params.handoffNote.whatRemains, 'whatRemains'),
          pitfalls: clampOptional(params.handoffNote.pitfalls, 'pitfalls'),
          openQuestions: clampOptional(params.handoffNote.openQuestions, 'openQuestions'),
          releasedAt: new Date().toISOString(),
        };
      }

      return state.runExclusive(async () => {
        const task = state.getTask(params.taskId!);
        if (!task) {
          throw notFound('Task', params.taskId!);
        }

        const previousWorkerId = task.assignedWorkerId;

        if (!previousWorkerId) {
          return {
            success: true,
            taskId: task.id,
            previousWorkerId: null,
            status: task.status,
            message: 'Task already unassigned',
            ...(normalizedHandoff ? { warning: 'handoffNote ignored: task was already unassigned' } : {}),
          };
        }

        // Build the update payload. If a handoff note was provided, prepend
        // it to priorHandoffs (newest-first) and cap the list.
        const updates: Record<string, unknown> = { assignedWorkerId: null };
        let nextPriorHandoffs = task.priorHandoffs;
        if (normalizedHandoff) {
          normalizedHandoff.releasedBy = params.workerId || previousWorkerId;
          if (params.reason) normalizedHandoff.reason = params.reason.slice(0, 2000);
          nextPriorHandoffs = [normalizedHandoff, ...(task.priorHandoffs ?? [])].slice(
            0,
            MAX_HANDOFFS_PER_TASK
          );
          updates.priorHandoffs = nextPriorHandoffs;
        }

        const updated = await state.updateTask(task.id, updates, 'WORKER_RELEASED');

        const worker = state.getWorker(previousWorkerId);
        if (worker && worker.currentTaskId === task.id) {
          await state.updateWorker(previousWorkerId, {
            currentTaskId: null,
            status: 'IDLE'
          });
        }

        const reasonSuffix = params.reason ? ` (${params.reason})` : '';
        const baseMsg = `🔓 ${previousWorkerId} released task: ${updated.title}${reasonSuffix}`;
        let chatMsg: string;
        let warning: string | undefined;
        if (normalizedHandoff) {
          const doneSummary = normalizedHandoff.whatIsDone.slice(0, 140);
          const remainsSummary = normalizedHandoff.whatRemains.slice(0, 140);
          chatMsg = `${baseMsg}\n  done: ${doneSummary}\n  remains: ${remainsSummary}`;
        } else {
          chatMsg = `${baseMsg} (released without handoff)`;
          warning = 'release_task called without handoffNote; next claimer will lack context.';
        }
        try { await state.postToGeneral(chatMsg); } catch { /* never block tool */ }
        try { await state.postToRoleChannel('workers', chatMsg); } catch { /* never block tool */ }
        try { await state.postToRoleChannel('governors', chatMsg); } catch { /* never block tool */ }

        return {
          success: true,
          taskId: updated.id,
          previousWorkerId,
          status: updated.status,
          priorHandoffCount: (nextPriorHandoffs?.length) ?? (updated.priorHandoffs?.length ?? 0),
          message: `Task ${updated.id} released from ${previousWorkerId}${reasonSuffix}`,
          ...(warning ? { warning } : {}),
        };
      });
    }
  };
}
