import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { HandoffNote } from '../types/schema.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { nextStatusForRelease } from '../state/workerLifecycle.js';
import { computeDiskStateSignature } from '../util/diskState.js';

const MAX_HANDOFFS_PER_TASK = 20;
const MAX_HANDOFF_FIELD_LEN = 4000;
/** Refusal cascade: this many empty-progress releases inside the window park the task. */
const REFUSAL_CASCADE_THRESHOLD = 3;
const REFUSAL_CASCADE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A "refusal" is a release whose handoff says, in the structured `whatIsDone`
 * field, that nothing was done. Deliberately conservative: only the fixed
 * shapes below count, so a handoff describing partial work — the normal
 * context-switch case — never feeds the cascade. An empty/missing value means
 * "unknown", not "zero progress", and does NOT count (persisted notes always
 * carry a non-empty whatIsDone; a hand-edited .moe/ file might not).
 */
function isEmptyProgressHandoff(handoff: Pick<HandoffNote, 'whatIsDone'> | undefined): boolean {
  const done = typeof handoff?.whatIsDone === 'string' ? handoff.whatIsDone.trim().toLowerCase() : '';
  if (done.length === 0) return false;
  if (done === 'nothing' || done === 'none' || done === 'n/a' || done === 'na') return true;
  return /^nothing\b/.test(done) || /^no progress\b/.test(done);
}

/**
 * Count the empty-progress releases in `handoffs` (newest-first, already capped
 * at MAX_HANDOFFS_PER_TASK) that landed within the 24h ending at `nowMs`.
 * Non-finite, future, and out-of-window `releasedAt` values are skipped — a
 * timestamp we cannot place in time is not evidence of anything.
 */
function countRecentRefusals(handoffs: HandoffNote[] | undefined, nowMs: number): number {
  // .moe/tasks/*.json is hand-editable: a non-array here would otherwise
  // iterate characters (string) or throw (object).
  if (!Array.isArray(handoffs)) return 0;
  const cutoffMs = nowMs - REFUSAL_CASCADE_WINDOW_MS;
  let count = 0;
  for (const handoff of handoffs) {
    if (!isEmptyProgressHandoff(handoff)) continue;
    const releasedMs = Date.parse(handoff.releasedAt);
    if (!Number.isFinite(releasedMs) || releasedMs < cutoffMs || releasedMs > nowMs) continue;
    count++;
  }
  return count;
}

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
    description: 'Release a task from its assigned worker (clears assignedWorkerId and keeps the task claimable in place: WORKING stays WORKING so the next worker resumes it via handoffs, or →REVIEW if every step is already done; PLANNING/REVIEW/AWAITING_APPROVAL stay put). Anyone can call — but NEVER on idle/staleness alone: a quiet worker may be mid-build. Release only for confirmed crashes (deregister banner, wrapper exit, human confirmation) or an explicit handoff. One exception to in-place routing: the 3rd release in 24h whose handoffNote.whatIsDone reports no progress ("nothing"/"none"/"n/a") parks the task to BACKLOG for human triage and returns cascadeTriggered:true (disable via settings.refusalCascadeAutoBacklog:false). To pull a task OUT of the agent pool yourself, have a human/governor use moe.set_task_status → BACKLOG.',
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
        // Fingerprint the working tree the note is describing. This spawns a
        // git subprocess, so it stays in the pre-mutex region with the shape
        // validation above — never inside runExclusive, which serializes every
        // tool fleet-wide. A failed capture leaves the field absent (absence
        // reads as "unknown", never as "unchanged").
        // release_task is a recovery path: it must never fail because a
        // fingerprint could not be taken. The helper contracts never to throw;
        // the catch makes that non-negotiable.
        try {
          const signature = await computeDiskStateSignature(state.projectPath);
          if (typeof signature === 'string' && signature.length > 0) {
            normalizedHandoff.diskState = signature;
          }
        } catch { /* capture is best-effort; absence reads as "unknown" */ }
      }
      const diskStateCaptured = normalizedHandoff?.diskState !== undefined;

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
            ...(diskStateCaptured ? { diskStateCaptured: true } : {}),
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

        // Refusal cascade. A task that three separate claims could not move at
        // all is an environmental/spec problem, and requeueing it just claim-
        // thrashes the next agent into the same wall — the same reasoning that
        // makes the blocked-timeout sweep park instead of requeue. So the third
        // empty-progress release inside 24h routes to BACKLOG (human-gated)
        // instead of the normal in-place routing. Only real assigned-worker
        // releases with a handoff can count: already-unassigned repair calls
        // are not claim refusals, and a release with no handoff leaves progress
        // unknown. Reads `!== false` so projects predating the setting keep the
        // protection. The scan is bounded by the 20-entry handoff cap — no I/O,
        // no unbounded work under the state mutex.
        const cascadeEligible =
          normalizedHandoff !== null &&
          isEmptyProgressHandoff(normalizedHandoff) &&
          state.project?.settings?.refusalCascadeAutoBacklog !== false;
        // `park` is the existing blocked-timeout routing: PLANNING/WORKING/
        // REVIEW → BACKLOG, while DONE/ARCHIVED/AWAITING_APPROVAL stay put. A
        // status it refuses to park is left on its normal release route.
        const parkStatus = cascadeEligible ? nextStatusForRelease(task, 'park') : undefined;
        const refusalCount = cascadeEligible
          ? countRecentRefusals(nextPriorHandoffs, Date.parse(normalizedHandoff!.releasedAt))
          : 0;
        const cascadeTriggered =
          parkStatus === 'BACKLOG' &&
          task.status !== 'BACKLOG' &&
          refusalCount >= REFUSAL_CASCADE_THRESHOLD;
        if (cascadeTriggered) {
          updates.status = parkStatus;
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

        if (cascadeTriggered) {
          // Posted after the task/worker writes landed: the release itself is
          // already durable, so a chat failure here must not roll it back or
          // surface as a tool error — same best-effort contract as above.
          const cascadeMsg =
            `🛑 task ${updated.id} (${updated.title}) parked to BACKLOG after ` +
            `${REFUSAL_CASCADE_THRESHOLD} empty-progress releases in 24h — no claim moved it, ` +
            `so requeueing would only thrash the next agent. A human must reprioritize, ` +
            `re-scope, or unblock it (moe.set_task_status → PLANNING/WORKING).`;
          try { await state.postToRoleChannel('governors', cascadeMsg); } catch { /* never block tool */ }
        }

        return {
          success: true,
          taskId: updated.id,
          previousWorkerId,
          status: updated.status,
          priorHandoffCount: (nextPriorHandoffs?.length) ?? (updated.priorHandoffs?.length ?? 0),
          ...(diskStateCaptured ? { diskStateCaptured: true } : {}),
          ...(cascadeTriggered ? { cascadeTriggered: true } : {}),
          message: cascadeTriggered
            ? `Task ${updated.id} released from ${previousWorkerId}${reasonSuffix} and parked to BACKLOG after ${REFUSAL_CASCADE_THRESHOLD} empty-progress releases in 24h; a human must reprioritize it`
            : `Task ${updated.id} released from ${previousWorkerId}${reasonSuffix}`,
          ...(warning ? { warning } : {}),
        };
      });
    }
  };
}
