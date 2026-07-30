import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskStatus, TaskPriority } from '../types/schema.js';
import { missingRequired, invalidInput } from '../util/errors.js';

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
        status: { type: 'string', enum: ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'] },
        priority: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
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
        priority?: TaskPriority;
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

      const validStatuses = ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'];
      if (params.status && !validStatuses.includes(params.status)) {
        throw invalidInput('status', `must be one of: ${validStatuses.join(', ')}`);
      }

      const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
      if (params.priority && !validPriorities.includes(params.priority)) {
        throw invalidInput('priority', `must be one of: ${validPriorities.join(', ')}`);
      }

      const task = await state.createTask({
        epicId: params.epicId,
        title: params.title,
        description: params.description,
        definitionOfDone: params.definitionOfDone,
        taskRails: params.taskRails,
        status: params.status,
        priority: params.priority,
        parentTaskId: params.parentTaskId,
        order: params.order,
        createdBy: params.createdBy || 'WORKER'
      });

      // Advisory sizing feedback at creation time — the hard gate lives in
      // submit_plan (step/file counts are only machine-visible there), but
      // surfacing shape problems now is cheaper than bouncing a plan later.
      const warnings: string[] = [];
      const dodCount = params.definitionOfDone?.filter((d) => typeof d === 'string' && d.trim().length > 0).length ?? 0;
      if (dodCount === 0) {
        warnings.push(
          'definitionOfDone is empty (a placeholder was substituted). Give every task 3-7 mechanically checkable items — a command to run or a test to pass — so the worker has a stopping condition and QA has a rubric.'
        );
      } else if (dodCount > 7) {
        warnings.push(
          `definitionOfDone has ${dodCount} items (target 3-7). A DoD this wide usually means the task is several tasks — split it (moe-epic-breakdown / SPIDR) before planning; oversized plans are rejected at submit_plan.`
        );
      }
      if (/\band\b/i.test(params.title)) {
        warnings.push(
          'Title contains "and" — often two tasks wearing one title. Split unless the halves genuinely cannot land independently.'
        );
      }

      return { success: true, task, ...(warnings.length > 0 ? { warnings } : {}) };
    }
  };
}
