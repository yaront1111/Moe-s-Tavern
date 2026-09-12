import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ExecutionAttempt } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput, missingRequired } from '../util/errors.js';
import { getAttempt, setAttemptPhase } from '../state/attemptStore.js';

// =============================================================================
// moe.reattach_attempt — the runner says "that execution is still mine"
// =============================================================================
//
// A daemon restart cannot see the processes the previous daemon was watching, so
// every `running` attempt is parked in `reconciling` at startup and its task is
// HELD instead of released. This tool is how the hold ends in the good case: the
// runner comes back and names the execution it is still driving, and the attempt
// returns to `running` with the task never having moved.
//
// WHAT A MATCH PROVES, AND WHAT IT DOES NOT. The identity is the attempt id, the
// generation, the recorded process start time and the recorded host. Matching
// all four NARROWS WHICH PROCESS the runner means — it rules out a reused pid, a
// stale session and another machine. It does NOT establish that the process is
// alive, and nothing anywhere may treat it as proof of that: the daemon never
// probes a process, and a caller could present these values for a process that
// died a second ago. What the match actually buys is that the seat is not handed
// to a stranger while its owner may still be mid-build.
//
// It reads no idle signal either. lastActivityAt has nothing to say here — a
// quiet build is not evidence of a dead worker, in either direction.
//
// DELIBERATELY WRITES ONLY THE ATTEMPT. The task and the worker record were
// never disturbed by the hold, which is the entire claim the restart contract
// makes; rewriting them here would create a second source of truth for an
// ownership that never changed.
// =============================================================================

/** The exact fields a reattaching runner must present. */
interface ReattachParams {
  taskId: string;
  workerId: string;
  runnerId: string;
  attemptId: string;
  generation: number;
  processStartedAt: string;
  host: string;
}

interface ReattachArgs {
  taskId?: unknown;
  workerId?: unknown;
  runnerId?: unknown;
  attemptId?: unknown;
  generation?: unknown;
  processStartedAt?: unknown;
  host?: unknown;
}

function requireNonBlank(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') throw missingRequired(field);
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidInput(field, `must be a non-blank string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function validate(args: ReattachArgs): ReattachParams {
  const taskId = requireNonBlank('taskId', args.taskId);
  const workerId = requireNonBlank('workerId', args.workerId);
  const runnerId = requireNonBlank('runnerId', args.runnerId);
  const attemptId = requireNonBlank('attemptId', args.attemptId);
  if (args.generation === undefined || args.generation === null) throw missingRequired('generation');
  if (typeof args.generation !== 'number' || !Number.isSafeInteger(args.generation) || args.generation < 1) {
    throw invalidInput('generation', `must be a positive safe integer (got ${JSON.stringify(args.generation)})`);
  }
  return {
    taskId,
    workerId,
    runnerId,
    attemptId,
    generation: args.generation,
    processStartedAt: requireNonBlank('processStartedAt', args.processStartedAt),
    host: requireNonBlank('host', args.host),
  };
}

function conflict(message: string, context: Record<string, unknown>, codeName: string): MoeError {
  return new MoeError(MoeErrorCode.STATE_CONFLICT, message, context, codeName);
}

/**
 * Every element of the identity must match, and the timestamp is compared as the
 * EXACT stored string rather than by parsing to a date: two spellings of the
 * same instant are not the same recorded value, and parsing would silently widen
 * the match a re-serialised value should have failed.
 *
 * An attempt recorded WITHOUT a process start time or host — opened before those
 * hints existed — has nothing to compare, so it can never be matched. Refusing
 * it is the safe direction: the alternative is letting any caller adopt any
 * hint-less attempt by naming it.
 *
 * `workerId` and `runnerId` are deliberately NOT compared. claim_next_task opens
 * attempts with `runnerId = workerId`, so a real runner's own id would never
 * match the stored one and every genuine reattach would be refused — the same
 * trap a named regression test pins for finalize_attempt. They identify the
 * caller for the log, not the process.
 */
function identityMismatch(attempt: ExecutionAttempt, params: ReattachParams): string | null {
  if (attempt.generation !== params.generation) return 'generation';
  if (attempt.processStartedAt === undefined) return 'processStartedAt (none recorded)';
  if (attempt.processStartedAt !== params.processStartedAt) return 'processStartedAt';
  if (attempt.host === undefined) return 'host (none recorded)';
  if (attempt.host !== params.host) return 'host';
  return null;
}

export function reattachAttemptTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.reattach_attempt',
    description:
      'Reattach a runner to its own execution attempt after a daemon restart, moving the attempt from `reconciling` back to `running` and ending the hold on its task. The runner must present the attempt id, generation, recorded process start time and host, and ALL of them must match. Idempotent: reattaching an already-running attempt is a no-op that succeeds, so a retry after a lost response is safe. A match narrows WHICH process the runner means; it is not evidence that the process is alive.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task the attempt belongs to.' },
        workerId: { type: 'string', description: 'Worker seat that owns the attempt.' },
        runnerId: { type: 'string', description: 'Wrapper/runner session driving the process.' },
        attemptId: { type: 'string', description: 'Attempt to reattach, as returned by moe.claim_next_task.' },
        generation: { type: 'number', description: 'Fencing token from the same claim. A superseded value is refused.' },
        processStartedAt: {
          type: 'string',
          description: 'The process start time exactly as it was recorded on the attempt. Compared as a string, not as a date.'
        },
        host: { type: 'string', description: 'The host exactly as it was recorded on the attempt.' }
      },
      required: ['taskId', 'workerId', 'runnerId', 'attemptId', 'generation', 'processStartedAt', 'host'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      return state.runExclusive(async () => {
        const params = validate((args || {}) as ReattachArgs);

        const attempt = getAttempt(state, params.attemptId);
        if (!attempt) {
          throw new MoeError(
            MoeErrorCode.NOT_FOUND,
            `Attempt not found: ${params.attemptId}`,
            { attemptId: params.attemptId, taskId: params.taskId },
            'ATTEMPT_NOT_FOUND'
          );
        }
        if (attempt.taskId !== params.taskId) {
          throw conflict(
            `Attempt ${attempt.id} belongs to task ${attempt.taskId}, not ${params.taskId}`,
            { attemptId: attempt.id, existingTaskId: attempt.taskId, requestedTaskId: params.taskId },
            'ATTEMPT_ID_TASK_MISMATCH'
          );
        }

        // Thrown BEFORE any write, because a refused reattach must leave the
        // task, the worker record and the attempt byte-identical.
        const mismatched = identityMismatch(attempt, params);
        if (mismatched !== null) {
          throw conflict(
            `Attempt ${attempt.id} does not match the presented identity (${mismatched} differs); ` +
              'reattachment requires the attempt id, generation, recorded process start time and ' +
              'host to match exactly.',
            {
              attemptId: attempt.id,
              taskId: attempt.taskId,
              field: mismatched,
              generation: attempt.generation,
            },
            'ATTEMPT_IDENTITY_MISMATCH'
          );
        }

        // Only `reconciling` (the restart hold) and `running` (an idempotent
        // repeat) may be reattached. `closed` is terminal history whose seat is
        // already given up, and a `finalizing` attempt belongs to a complete_task
        // that is still landing its bytes — dragging it back to running here
        // would silently lift the finalizing hold on claim_next_task and
        // qa_approve. That runner wants moe.finalize_attempt, not this tool.
        if (attempt.phase !== 'reconciling' && attempt.phase !== 'running') {
          throw conflict(
            `Attempt ${attempt.id} is in phase ${attempt.phase} and cannot be reattached; only a ` +
              'reconciling or already-running attempt may be.',
            { attemptId: attempt.id, taskId: attempt.taskId, phase: attempt.phase },
            'ATTEMPT_NOT_REATTACHABLE'
          );
        }

        // The single write — and a no-op when the attempt is already running,
        // because setAttemptPhase treats a repeated phase as no write at all.
        // That is what makes a retry after a lost response safe.
        const running = await setAttemptPhase(state, attempt.id, 'running');
        return {
          success: true,
          attemptId: running.id,
          taskId: running.taskId,
          generation: running.generation,
          phase: running.phase,
          message:
            `Attempt ${running.id} (generation ${running.generation}) on task ${running.taskId} is ` +
            'running again and its task stays assigned. The identity matched, which narrows which ' +
            'process this is — it is not evidence that the process is alive.',
        };
      });
    }
  };
}
