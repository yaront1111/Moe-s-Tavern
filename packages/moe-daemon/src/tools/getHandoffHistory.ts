import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound } from '../util/errors.js';

export function getHandoffHistoryTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_handoff_history',
    description: 'Return prior handoff notes + priorAttempt for a task. Call this when claiming a released task so you don\'t redo finished work.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task to inspect' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string };
      if (!params.taskId) {
        throw missingRequired('taskId');
      }
      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }
      return {
        taskId: task.id,
        priorHandoffs: task.priorHandoffs ?? [],
        priorAttempt: task.priorAttempt ?? null,
      };
    }
  };
}
