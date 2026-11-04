import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { countOpenAttempts } from '../state/attemptStore.js';
import { hasControlChar } from '../state/candidateStore.js';
import { invalidInput } from '../util/errors.js';

/**
 * Wider than the 128 CQ-M07g's ledger caps a workerId at, so every id it
 * records is accepted here.
 */
const MAX_WORKER_ID_CHARS = 255;

function readWorkerId(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('workerId', 'must be a non-blank string');
  // The bound comes first: this handler runs under the state mutex, so an
  // over-long id is refused in O(1), before anything walks the string.
  if (value.length > MAX_WORKER_ID_CHARS) {
    throw invalidInput('workerId', `must be ${MAX_WORKER_ID_CHARS} characters or fewer`);
  }
  if (value.trim() === '') throw invalidInput('workerId', 'must be a non-blank string');
  if (hasControlChar(value)) throw invalidInput('workerId', 'must not contain control characters');
  return value;
}

export function getSeatLivenessTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_seat_liveness',
    description:
      'Wrapper-only, read-only. Reports whether a worker seat is gone: no worker record (or a DEAD one) and no open execution attempt carrying its workerId. Returns { workerId, registered, status, openAttempts }. A match never proves a process is alive.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'The worker seat to inspect' },
      },
      required: ['workerId'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      const workerId = readWorkerId((args as { workerId?: unknown } | undefined | null)?.workerId);
      const worker = state.workers.get(workerId);
      return {
        workerId,
        registered: worker !== undefined,
        status: worker?.status ?? null,
        openAttempts: countOpenAttempts(state, workerId),
      };
    },
  };
}
