import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import {
  DEFAULT_TASK_LIST_LIMIT,
  DEFAULT_TASK_LIST_OFFSET,
  MAX_TASK_LIST_LIMIT,
  normalizeIntegerOption,
  taskSummary,
} from '../util/taskPayload.js';

export function listTasksTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.list_tasks',
    description: 'List tasks for an epic (optionally by status)',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string' },
        status: { type: 'array', items: { type: 'string' } },
        limit: {
          type: 'number',
          description: 'Maximum number of task summaries to return (default: 100, max: 500)',
          default: DEFAULT_TASK_LIST_LIMIT
        },
        offset: {
          type: 'number',
          description: 'Number of matching tasks to skip for pagination (default: 0)',
          default: DEFAULT_TASK_LIST_OFFSET
        }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { epicId?: string; status?: string[]; limit?: number; offset?: number };
      const limit = normalizeIntegerOption(
        params.limit,
        'limit',
        DEFAULT_TASK_LIST_LIMIT,
        1,
        MAX_TASK_LIST_LIMIT
      );
      const offset = normalizeIntegerOption(
        params.offset,
        'offset',
        DEFAULT_TASK_LIST_OFFSET,
        0,
        Number.MAX_SAFE_INTEGER
      );

      const tasks = Array.from(state.tasks.values()).filter((task) => {
        if (params.epicId && task.epicId !== params.epicId) return false;
        if (params.status && params.status.length > 0) {
          return params.status.includes(task.status);
        }
        return true;
      });

      const epic = params.epicId ? state.getEpic(params.epicId) : null;

      // Sort tasks by order for consistent output
      const sortedTasks = [...tasks].sort((a, b) => a.order - b.order);
      const pagedTasks = sortedTasks.slice(offset, offset + limit);

      const counts = {
        total: tasks.length,
        backlog: tasks.filter((t) => t.status === 'BACKLOG').length,
        planning: tasks.filter((t) => t.status === 'PLANNING').length,
        awaitingApproval: tasks.filter((t) => t.status === 'AWAITING_APPROVAL').length,
        inProgress: tasks.filter((t) => t.status === 'WORKING').length,
        review: tasks.filter((t) => t.status === 'REVIEW').length,
        done: tasks.filter((t) => t.status === 'DONE').length,
        archived: tasks.filter((t) => t.status === 'ARCHIVED').length
      };

      // Build response with explicit null handling
      const response: {
        epicId: string | null;
        epicTitle: string | null;
        epicStatus: string | null;
        tasks: Array<ReturnType<typeof taskSummary>>;
        counts: typeof counts;
        pagination: {
          limit: number;
          offset: number;
          returned: number;
          total: number;
          hasMore: boolean;
        };
      } = {
        epicId: epic?.id ?? params.epicId ?? null,
        epicTitle: epic?.title ?? null,
        epicStatus: epic?.status ?? null,
        tasks: pagedTasks.map((t) => taskSummary(t)),
        counts,
        pagination: {
          limit,
          offset,
          returned: pagedTasks.length,
          total: sortedTasks.length,
          hasMore: offset + pagedTasks.length < sortedTasks.length,
        }
      };

      return response;
    }
  };
}
