import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { WorkerType } from '../types/schema.js';
import { missingRequired, notFound } from '../util/errors.js';
import { logger } from '../util/logger.js';

// Record<WorkerType, true> makes tsc fail if WorkerType grows without this list.
const WORKER_TYPES: Record<WorkerType, true> = { CLAUDE: true, CODEX: true, GEMINI: true, GROK: true };

/** Exact, case-sensitive WorkerType name; anything else (never a refusal) is CLAUDE. */
export function normalizeWorkerType(value: unknown): WorkerType {
  return typeof value === 'string' && Object.hasOwn(WORKER_TYPES, value) ? (value as WorkerType) : 'CLAUDE';
}

/**
 * Record a seat's reported type on its existing record. Omitted (undefined) means
 * not reported, so the stored type stays; it never creates a record, and it skips
 * the write when nothing changes (claim_next_task is polled). The stored
 * lastActivityAt is passed back so a type change never counts as presence.
 * Informational only: a failed write is logged and never fails the calling tool.
 */
export async function refreshWorkerType(
  state: StateManager,
  workerId: string | undefined,
  reported: unknown
): Promise<void> {
  if (!workerId || reported === undefined) return;
  const worker = state.getWorker(workerId);
  if (!worker) return;
  const type = normalizeWorkerType(reported);
  if (type === worker.type) return;
  try {
    await state.updateWorker(workerId, { type, lastActivityAt: worker.lastActivityAt });
  } catch (err) {
    // `err` (not `error`) so pino serializes the message and stack instead of {}.
    logger.warn({ workerId, type, err }, 'Failed to record reported worker type');
  }
}

export const WORKER_TYPE_SCHEMA = {
  type: 'string',
  description:
    'The seat\'s CLI: CLAUDE, CODEX, GEMINI or GROK (exact, case-sensitive). Any other value is recorded as CLAUDE. ' +
    'Omit it to leave an existing record\'s type alone (a new record is CLAUDE).'
};

export function joinTeamTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.join_team',
    description: 'Add a worker to a team. Auto-registers worker if not exists; a successful join revives a DEAD worker to IDLE and records the optional reported workerType.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'The team ID to join' },
        workerId: { type: 'string', description: 'The worker ID' },
        workerType: WORKER_TYPE_SCHEMA
      },
      required: ['teamId', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { teamId?: string; workerId?: string; workerType?: unknown };

      if (!params.teamId) throw missingRequired('teamId');
      if (!params.workerId) throw missingRequired('workerId');

      const team = state.getTeam(params.teamId);
      if (!team) throw notFound('Team', params.teamId);

      // Auto-register worker if it doesn't exist
      if (!state.getWorker(params.workerId)) {
        await state.createWorker({
          id: params.workerId,
          type: normalizeWorkerType(params.workerType),
          projectId: state.project!.id,
          epicId: '',
          currentTaskId: null,
          status: 'IDLE'
        });
      }

      const updated = await state.addTeamMember(params.teamId, params.workerId);

      // A join is the seat's fresh registration (its wrapper pre-flight), so it
      // revives a DEAD record, e.g. after a hot reload's deregister. Heartbeats
      // (touchWorker) still refuse DEAD: those may be the old session's calls.
      if (state.getWorker(params.workerId)?.status === 'DEAD') {
        await state.updateWorker(params.workerId, { status: 'IDLE' });
      }

      // Last, so only a successful join refreshes an existing record's type.
      await refreshWorkerType(state, params.workerId, params.workerType);

      return { team: updated };
    }
  };
}
