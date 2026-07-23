import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { HandoffNote } from '../types/schema.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { nextStatusForRelease } from '../state/workerLifecycle.js';

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
    description: 'Release a task from its assigned worker (clears assignedWorkerId and keeps the task claimable in place: WORKING stays WORKING so the next worker resumes it via handoffs, or →REVIEW if every step is already done; PLANNING/REVIEW/AWAITING_APPROVAL stay put). Anyone can call — but NEVER on idle/staleness alone: a quiet worker may be mid-build. Release only for confirmed crashes (deregister banner, wrapper exit, human confirmation) or an explicit handoff. To pull a task OUT of the agent pool instead, have a human/governor use moe.set_task_status → BACKLOG.',
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
          // Terminal tasks are never "stuck": a duplicate/late release_task on
          // a DONE/ARCHIVED task (proxy retry, agent cleanup, release racing a
          // qa_approve that landed first) must stay a strict no-op — routing it
          // through nextStatusForRelease used to resurrect finished work.
          if (task.status === 'DONE' || task.status === 'ARCHIVED') {
            return {
              success: true,
              taskId: task.id,
              previousWorkerId: null,
              status: task.status,
              message: `Task is ${task.status}; nothing to release`,
              ...(normalizedHandoff ? { warning: `handoffNote ignored: task is ${task.status}` } : {}),
            };
          }

          // The task is already unassigned. WORKING-but-unassigned is a
          // perfectly claimable state (workers claim statuses:["WORKING"]), so
          // the only repair left is the all-steps-done case: route finished
          // work to REVIEW so QA picks it up instead of a worker re-claiming a
          // task with nothing left to do. Also persist the caller's
          // handoffNote instead of silently discarding it, and clear
          // needsHumanReview — release_task is one of the documented human
          // unpark paths for a qa_reject-capped task (see schema.ts).
          const correctedStatus = task.status === 'WORKING' ? nextStatusForRelease(task) : task.status;
          const unparking = task.needsHumanReview === true;
          if (correctedStatus === task.status && !normalizedHandoff && !unparking) {
            return {
              success: true,
              taskId: task.id,
              previousWorkerId: null,
              status: task.status,
              message: 'Task already unassigned',
            };
          }

          const repairUpdates: Record<string, unknown> = {};
          if (correctedStatus !== task.status) repairUpdates.status = correctedStatus;
          if (unparking) repairUpdates.needsHumanReview = false;
          let repairedHandoffs = task.priorHandoffs;
          if (normalizedHandoff) {
            normalizedHandoff.releasedBy = params.workerId || 'unknown';
            if (params.reason) normalizedHandoff.reason = params.reason.slice(0, 2000);
            repairedHandoffs = [normalizedHandoff, ...(task.priorHandoffs ?? [])].slice(
              0,
              MAX_HANDOFFS_PER_TASK
            );
            repairUpdates.priorHandoffs = repairedHandoffs;
          }

          const repaired = await state.updateTask(task.id, repairUpdates, 'WORKER_RELEASED');

          if (correctedStatus !== task.status) {
            const msg = `🔧 task ${repaired.id} was unassigned but stuck in ${task.status}; auto-routed to ${correctedStatus}`;
            try { await state.postToGeneral(msg); } catch { /* never block tool */ }
            try { await state.postToRoleChannel('workers', msg); } catch { /* never block tool */ }
          }

          return {
            success: true,
            taskId: repaired.id,
            previousWorkerId: null,
            status: repaired.status,
            priorHandoffCount: repairedHandoffs?.length ?? 0,
            ...(unparking ? { unparked: true } : {}),
            message: correctedStatus !== task.status
              ? `Task was unassigned but stuck in ${task.status}; repaired to ${correctedStatus}`
              : (unparking ? 'Task unparked (needsHumanReview cleared); it re-enters the QA queue' : 'Task already unassigned; handoffNote recorded'),
          };
        }

        // Build the update payload. Route via the single release-routing
        // helper (same as the auto/deregister paths): WORKING stays WORKING
        // (unassigned = claimable by the next worker), all-steps-done → REVIEW,
        // PLANNING/REVIEW/AWAITING_APPROVAL stay put.
        const updates: Record<string, unknown> = {
          assignedWorkerId: null,
          status: nextStatusForRelease(task),
          // release_task is a documented human unpark path (schema.ts): clear
          // the qa_reject-cap park so the task re-enters the QA queue.
          ...(task.needsHumanReview === true ? { needsHumanReview: false } : {}),
        };
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
