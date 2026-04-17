import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired } from '../util/errors.js';

export function saveSessionSummaryTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.save_session_summary',
    description: 'Save a summary of your session before ending. Captures what you accomplished and key findings for the next agent working on this task.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Your worker ID' },
        taskId: { type: 'string', description: 'The task ID you worked on' },
        summary: { type: 'string', description: 'What you accomplished and key findings (max 5000 chars)' },
        memoriesCreated: { type: 'array', items: { type: 'string' }, description: 'IDs of memories saved this session' },
      },
      required: ['workerId', 'taskId', 'summary'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        workerId?: string; taskId?: string; summary?: string; memoriesCreated?: string[];
      };

      if (!params.workerId) throw missingRequired('workerId');
      if (!params.taskId) throw missingRequired('taskId');
      if (!params.summary?.trim()) throw missingRequired('summary');

      // Determine role from worker
      const worker = state.getWorker(params.workerId);
      const role = worker ? guessRole(worker.status) : 'unknown';

      const mm = state.getMemoryManager();
      const session = await mm.saveSessionSummary({
        workerId: params.workerId,
        taskId: params.taskId,
        role,
        summary: params.summary,
        memoriesCreated: params.memoriesCreated,
      });

      // Suggest the role-appropriate wait statuses so the agent can loop into the next task.
      const waitStatuses = role === 'architect' ? ['PLANNING']
        : role === 'qa' ? ['REVIEW']
        : ['WORKING'];

      return {
        sessionId: session.id,
        message: 'Session summary saved — next agent on this task will see your findings',
        nextAction: {
          tool: 'moe.wait_for_task',
          args: { statuses: waitStatuses, workerId: params.workerId },
          reason: 'Session wrapped up; block until the next task arrives for this role.',
        },
      };
    },
  };
}

function guessRole(status: string): string {
  if (status === 'PLANNING' || status === 'AWAITING_APPROVAL') return 'architect';
  if (status === 'CODING' || status === 'READING_CONTEXT') return 'worker';
  return 'worker';
}
