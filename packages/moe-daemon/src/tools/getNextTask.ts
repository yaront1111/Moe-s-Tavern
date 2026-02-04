import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { sortByOrder } from '../util/order.js';

export function getNextTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_next_task',
    description: 'Get the next backlog task for an epic',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { epicId?: string };
      const tasks = Array.from(state.tasks.values()).filter((task) => {
        if (params.epicId && task.epicId !== params.epicId) return false;
        return task.status === 'BACKLOG';
      });

      const ordered = sortByOrder(tasks);
      const next = ordered[0];

      if (!next) {
        return { hasNext: false };
      }

      return {
        hasNext: true,
        task: {
          id: next.id,
          title: next.title,
          description: next.description,
          definitionOfDone: next.definitionOfDone
        }
      };
    }
  };
}
