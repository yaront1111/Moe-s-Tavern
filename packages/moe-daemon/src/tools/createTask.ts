import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskStatus } from '../types/schema.js';
import { missingRequired } from '../util/errors.js';

export function createTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.create_task',
    description: 'Create a new task in an epic',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        definitionOfDone: { type: 'array', items: { type: 'string' } },
        taskRails: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        parentTaskId: { type: 'string' },
        order: { type: 'number' },
        createdBy: { type: 'string', enum: ['HUMAN', 'WORKER'] }
      },
      required: ['epicId', 'title'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        epicId?: string;
        title?: string;
        description?: string;
        definitionOfDone?: string[];
        taskRails?: string[];
        status?: TaskStatus;
        parentTaskId?: string;
        order?: number;
        createdBy?: 'HUMAN' | 'WORKER';
      };

      if (!params.epicId) {
        throw missingRequired('epicId');
      }
      if (!params.title) {
        throw missingRequired('title');
      }

      const task = await state.createTask({
        epicId: params.epicId,
        title: params.title,
        description: params.description,
        definitionOfDone: params.definitionOfDone,
        taskRails: params.taskRails,
        status: params.status,
        parentTaskId: params.parentTaskId,
        order: params.order,
        createdBy: params.createdBy || 'WORKER'
      });

      return { success: true, task };
    }
  };
}
