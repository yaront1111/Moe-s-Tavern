import type { ToolCallContext, ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { recordCheckDispatch, type RecordCheckDispatchParams } from '../state/checkObservationStore.js';
import { MoeError, MoeErrorCode, invalidInput } from '../util/errors.js';

// =============================================================================
// moe.record_check_dispatch: which check an authenticated runner will run
// =============================================================================
//
// Puts the dispatch half of state/checkObservationStore.ts on the wire. Every
// rule lives in that store: the task's CURRENT candidate, its tree, the
// current approved plan revision, same-id immutability.
//
// RUNNER CHANNEL ONLY. The runner identity is ToolCallContext.runner, which
// only an authenticated /runner connection sets (server/runnerChannel.ts).
// /mcp and /ws callers are refused before anything is read, and no argument
// can name a runner, a source or a tree: an unknown key is refused by name.
//
// RECORDING, NOT APPROVAL. Not `blocking`: dispatch serializes the tool under
// the state mutex, and the store's same-id check-then-write relies on it.
// =============================================================================

const TOOL_NAME = 'moe.record_check_dispatch';
const FIELDS = new Set(['id', 'taskId', 'candidateId', 'planRevision', 'command', 'checkId', 'environment', 'workerId']);

/**
 * The channel runner and the arguments of a runner-only tool. Refuses a call without context.runner
 * (RUNNER_CHANNEL_REQUIRED) before reading its arguments, then any key outside `fields` by name.
 * workerId stays allowed: the proxy injects it, and the stores never read or store it.
 */
export function runnerToolCall(toolName: string, what: string, fields: ReadonlySet<string>, args: unknown, context?: ToolCallContext) {
  const runner = context?.runner;
  if (!runner) {
    throw new MoeError(MoeErrorCode.NOT_ALLOWED, `${toolName} requires the authenticated runner channel (/runner)`, undefined, 'RUNNER_CHANNEL_REQUIRED');
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw invalidInput('params', 'must be an object');
  const unknownKey = Object.keys(args).find((key) => !fields.has(key));
  if (unknownKey !== undefined) throw invalidInput(unknownKey, `is not a supported ${what} field`);
  return { runner, params: args };
}

export function recordCheckDispatchTool(_state: StateManager): ToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Record a CheckDispatch: the check an authenticated runner is about to run for a task, persisted immutably at .moe/checks/dispatches/<id>.json. ' +
      'Runner channel only: a call over /mcp or /ws is refused (RUNNER_CHANNEL_REQUIRED) before anything is read, and runnerId comes from the channel, never from an argument. ' +
      'Pins the task\'s CURRENT candidate, that candidate\'s tree and the current approved plan revision: a superseded candidate (CHECK_DISPATCH_NOT_CURRENT), an unknown one (CANDIDATE_NOT_FOUND) ' +
      'or another revision (CHECK_DISPATCH_REVISION_MISMATCH) is refused. Immutable: an identical same-id call returns the stored dispatch with duplicate:true and writes nothing; ' +
      'a differing one is refused (CHECK_DISPATCH_IMMUTABLE). Any other argument, runnerId, source and treeSha included, is refused by name (INVALID_INPUT). ' +
      'Recorded, never approved: a dispatch marks nothing DONE and releases nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Optional dispatch id (letters, digits, - and _; at most 128 chars). Reuse it to retry after a crash; omit it and the daemon generates dispatch-<32 hex>.',
        },
        taskId: { type: 'string', description: 'The task whose check is dispatched.' },
        candidateId: { type: 'string', description: 'The task\'s current Candidate. Its tree is pinned from the candidate, never passed.' },
        planRevision: { type: 'integer', minimum: 1, description: 'The task\'s current approved plan revision.' },
        command: { type: 'string', description: 'The command the runner will run, recorded verbatim: non-blank, at most 500 characters.' },
        checkId: { type: 'string', description: 'Optional protected check id (1-64 letters, digits, ., _ or -, starting alphanumeric).' },
        environment: {
          type: 'string',
          description: 'Opaque execution-environment identity, e.g. an image digest: non-blank, at most 255 chars, no control characters, kept verbatim.',
        },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy). Not evidence and not stored.' },
      },
      required: ['taskId', 'candidateId', 'planRevision', 'command', 'environment'],
      additionalProperties: false,
    },
    handler: async (args, state, context) => {
      const { runner, params } = runnerToolCall(TOOL_NAME, 'check dispatch', FIELDS, args, context);
      const { dispatch, duplicate } = await recordCheckDispatch(state, runner, params as RecordCheckDispatchParams);
      return { success: true, dispatch, duplicate };
    },
  };
}
