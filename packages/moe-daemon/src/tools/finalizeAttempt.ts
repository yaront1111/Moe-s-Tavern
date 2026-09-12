import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ExecutionAttempt } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput, missingRequired, notFound } from '../util/errors.js';
import { getAttempt, setAttemptPhase } from '../state/attemptStore.js';
import { assertAttemptCurrent } from '../util/enforcement.js';

// =============================================================================
// moe.finalize_attempt — the runner closes the artifact boundary
// =============================================================================
//
// The RUNNER, not the CLI's exit, is what declares a task's bytes final. That
// distinction is the whole point: an interactive TUI seat stays open long after
// the work is landed, and a provider mode without one-shot semantics has no
// exit to infer anything from — so the boundary needs an explicit operation.
//
// complete_task leaves the owning attempt OPEN in `finalizing`, and while it is
// open two holds are in force: claim_next_task refuses that worker's next task,
// and qa_approve refuses that task's approval. Closing the attempt here is what
// lifts both.
//
// NOT a delivery record. `outcome` and `landedRevision` are what the runner
// REPORTED; the daemon is state-only and never runs git, so it has verified
// neither. They are echoed back and deliberately NOT persisted — a durable
// landing record is the receipt slice's job, and writing anything extra onto
// the attempt would make the idempotent repeat below produce different bytes.
// =============================================================================

/** The four real endings of a wrapper's landing attempt. */
const OUTCOMES = ['landed', 'nothing-to-commit', 'rescued', 'failed'] as const;
type FinalizeOutcome = (typeof OUTCOMES)[number];

/**
 * A git object name as the wrapper reports it: 40 hex characters. Case-insensitive
 * to match the sibling runner-called tool (`record_candidate`'s sha check) — two
 * tools in the same slice disagreeing about the case of a sha is exactly the kind
 * of interop trap that only shows up in production.
 */
const REVISION_PATTERN = /^[0-9a-f]{40}$/i;

interface FinalizeParams {
  taskId: string;
  attemptId: string;
  generation?: number;
  outcome: FinalizeOutcome;
  landedRevision: string | null;
  workerId?: string;
  runnerId?: string;
}

interface FinalizeArgs {
  taskId?: unknown;
  attemptId?: unknown;
  generation?: unknown;
  outcome?: unknown;
  landedRevision?: unknown;
  workerId?: unknown;
  runnerId?: unknown;
}

function requireNonBlank(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') throw missingRequired(field);
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidInput(field, `must be a non-blank string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function optionalNonBlank(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireNonBlank(field, value);
}

/**
 * `landedRevision` is REQUIRED when the runner claims a landing and refused as a
 * bare ref name either way: 'HEAD' or a branch name is not evidence of anything,
 * and a receipt built on one later would name bytes nobody can find again.
 */
function validateRevision(outcome: FinalizeOutcome, value: unknown): string | null {
  if (value === undefined || value === null) {
    if (outcome === 'landed') throw missingRequired('landedRevision');
    return null;
  }
  const revision = requireNonBlank('landedRevision', value);
  if (!REVISION_PATTERN.test(revision)) {
    throw invalidInput('landedRevision', `must be 40 hex characters (got ${JSON.stringify(revision)})`);
  }
  return revision;
}

function validate(args: FinalizeArgs): FinalizeParams {
  // Order matters only for which field a caller omitting several is told about
  // first: the two ids, then the outcome the revision check depends on.
  const taskId = requireNonBlank('taskId', args.taskId);
  const attemptId = requireNonBlank('attemptId', args.attemptId);
  const outcome = requireNonBlank('outcome', args.outcome);
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    throw invalidInput('outcome', `must be one of ${OUTCOMES.join(', ')} (got ${JSON.stringify(outcome)})`);
  }
  let generation: number | undefined;
  if (args.generation !== undefined && args.generation !== null) {
    if (typeof args.generation !== 'number' || !Number.isSafeInteger(args.generation) || args.generation < 1) {
      throw invalidInput('generation', `must be a positive safe integer (got ${JSON.stringify(args.generation)})`);
    }
    generation = args.generation;
  }
  return {
    taskId,
    attemptId,
    generation,
    outcome: outcome as FinalizeOutcome,
    landedRevision: validateRevision(outcome as FinalizeOutcome, args.landedRevision),
    workerId: optionalNonBlank('workerId', args.workerId),
    runnerId: optionalNonBlank('runnerId', args.runnerId),
  };
}

function conflict(message: string, context: Record<string, unknown>, codeName: string): MoeError {
  return new MoeError(MoeErrorCode.STATE_CONFLICT, message, context, codeName);
}

/** The response, built the same way on the first call and on every repeat. */
function response(attempt: ExecutionAttempt, params: FinalizeParams) {
  return {
    success: true,
    attemptId: attempt.id,
    taskId: attempt.taskId,
    generation: attempt.generation,
    phase: 'closed',
    outcome: params.outcome,
    landedRevision: params.landedRevision,
    message:
      `Attempt ${attempt.id} (generation ${attempt.generation}) on task ${attempt.taskId} is closed ` +
      `with outcome ${params.outcome}. The finalizing hold on the worker's next claim and on ` +
      'qa_approve is lifted.',
  };
}

export function finalizeAttemptTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.finalize_attempt',
    description:
      'Close a task\'s execution attempt after the runner has reported its landing outcome, moving the attempt from `finalizing` to `closed`. This is what lifts the finalizing hold on the worker\'s next claim and on qa_approve — the runner declares the bytes final, not the CLI\'s exit, so an interactive seat that stays open can still finalize. Fenced by attempt id + generation, and idempotent: repeating a call after a lost response writes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task the attempt belongs to.' },
        workerId: { type: 'string', description: 'Worker seat that held the attempt (auto-injected by proxy).' },
        runnerId: { type: 'string', description: 'Wrapper/runner session reporting the landing.' },
        attemptId: { type: 'string', description: 'Attempt to close, as returned by moe.claim_next_task.' },
        generation: { type: 'number', description: 'Fencing token from the same claim. A superseded value is refused.' },
        outcome: {
          type: 'string',
          enum: [...OUTCOMES],
          description: 'What the runner\'s landing actually did. Reported, never verified by the daemon.'
        },
        landedRevision: {
          type: 'string',
          description: 'The 40-hex commit the bytes landed as. Required when outcome is "landed".'
        }
      },
      required: ['taskId', 'attemptId', 'outcome'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      return state.runExclusive(async () => {
        const params = validate((args || {}) as FinalizeArgs);

        const task = state.getTask(params.taskId);
        if (!task) throw notFound('Task', params.taskId);

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

        // IDEMPOTENCY, AND IT MUST COME BEFORE THE FENCING CALL. A retry after a
        // lost response is the normal case for an exit trap, so it answers with
        // the first call's response and writes nothing at all.
        //
        // DO NOT "TIDY" THIS BELOW assertAttemptCurrent. That guard resolves the
        // current attempt through currentAttempt(), which only ever returns a
        // NON-closed attempt — so on the second call it would see 'none (all
        // closed)' and refuse with ATTEMPT_SUPERSEDED. The repeat would fail and
        // look correct in review. This is not a fencing bypass either: closing
        // an already-closed attempt changes nothing, and every OPEN case below
        // still goes through the guard.
        if (attempt.phase === 'closed') return response(attempt, params);

        assertAttemptCurrent(
          state,
          task,
          { attemptId: params.attemptId, generation: params.generation },
          'moe.finalize_attempt'
        );

        // Only a FINALIZING attempt may be closed here. Closing a `running` one
        // would hand the seat back with nothing landed, which is the exact race
        // the hold exists to stop; `reconciling` belongs to the recovery slice.
        if (attempt.phase !== 'finalizing') {
          throw conflict(
            `Attempt ${attempt.id} is in phase ${attempt.phase}, not finalizing; only a finalizing ` +
              'attempt may be closed by moe.finalize_attempt',
            { attemptId: attempt.id, taskId: attempt.taskId, phase: attempt.phase },
            'ATTEMPT_NOT_FINALIZING'
          );
        }

        // The single write. setAttemptPhase persists before publishing, and
        // re-asserting a phase is a no-op there, so lastPhaseAt records when the
        // phase actually changed.
        const closed = await setAttemptPhase(state, attempt.id, 'closed');
        return response(closed, params);
      });
    }
  };
}
