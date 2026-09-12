import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { recordCandidate, validateCandidateParams } from '../state/candidateStore.js';
import { assertAttemptCurrent, type AttemptIdentity } from '../util/enforcement.js';
import { invalidInput, notFound } from '../util/errors.js';

const TOOL_NAME = 'moe.record_candidate';

/**
 * The attempt's fencing token, read at the boundary without coercion: absent is
 * fine, a non-number is refused here, and assertAttemptCurrent refuses a number
 * outside the positive-safe-integer domain.
 */
function readGeneration(args: { generation?: unknown }): number | undefined {
  const raw = args.generation;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number') throw invalidInput('generation', 'must be a positive safe integer when supplied');
  return raw;
}

/**
 * Records the exact bytes a task is offering, as the runner reported them.
 *
 * NOT `blocking`: dispatch serializes every non-blocking tool under the global
 * state mutex, and candidateStore's check-then-write relies on exactly that.
 * No ownership or status gate: the runner records after complete_task, when QA
 * may already hold the task — the attempt fence is the guard that matters. The
 * handler never runs git and never starts a process: the shas are recorded as
 * reported and checked for shape only.
 */
export function recordCandidateTool(_state: StateManager): ToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Record a frozen Candidate: the exact bytes a task is offering for delivery (a runner-reported treeSha on a runner-reported baseRevision, aimed at deliveryTarget), persisted immutably as one file per candidate at .moe/candidates/<id>.json. ' +
      'Fenced BEFORE anything is written: attemptId (and generation, when supplied) must be the task\'s CURRENT attempt, else ATTEMPT_SUPERSEDED. ' +
      'Immutable: a changed tree needs a NEW id — a same-id record that differs in any field is refused (CANDIDATE_IMMUTABLE), while a byte-identical re-record is idempotent and returns the stored candidate with duplicate:true, so retrying after a crash is safe. ' +
      'The daemon never runs git: the shas are recorded as reported and checked for shape (7-40 hex) only. ' +
      'Other refusals: TASK_NOT_FOUND; ATTEMPT_NOT_FOUND / ATTEMPT_ID_TASK_MISMATCH (the attempt must exist and belong to the task); INVALID_INPUT / MISSING_REQUIRED. No ownership or status gate.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task the bytes belong to. Must exist.' },
        attemptId: {
          type: 'string',
          description: 'Id of the task\'s CURRENT execution attempt. A superseded or closed attempt is refused (ATTEMPT_SUPERSEDED) and nothing is written.',
        },
        generation: {
          type: 'integer',
          minimum: 1,
          description: 'Optional fencing token of that attempt. When supplied it must equal the current attempt\'s generation.',
        },
        id: {
          type: 'string',
          description: 'Optional candidate id (letters, digits, - and _; at most 128 chars). Supply one so a retry after a crash is idempotent; omit it and the daemon generates cand-<uuid>.',
        },
        baseRevision: {
          type: 'string',
          description: 'Commit sha (7-40 hex) the bytes were built on, as the runner observed it. Recorded as reported; the daemon never verifies it.',
        },
        treeSha: {
          type: 'string',
          description: 'Tree or commit sha (7-40 hex) naming the offered bytes, as the runner observed it. Recorded as reported; the daemon never verifies it.',
        },
        deliveryTarget: {
          type: 'string',
          description: 'Where the bytes are meant to land, e.g. refs/heads/wave1-pilot. Non-blank, no surrounding whitespace or control characters, at most 255 chars.',
        },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy). Not stored on the candidate.' },
      },
      required: ['taskId', 'attemptId', 'baseRevision', 'treeSha', 'deliveryTarget'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      // Validation first: the store owns the rules; this only applies them early.
      const params = validateCandidateParams(args);
      const generation = readGeneration(args as { generation?: unknown });

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      // The fence runs BEFORE the write, so a superseded attempt leaves nothing behind.
      const identity: AttemptIdentity = {
        attemptId: params.attemptId,
        ...(generation !== undefined ? { generation } : {}),
      };
      assertAttemptCurrent(state, task, identity, TOOL_NAME);

      const { candidate, duplicate } = await recordCandidate(state, params);
      return { success: true, candidate, duplicate };
    },
  };
}
