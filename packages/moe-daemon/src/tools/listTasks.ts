import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

export function listTasksTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.list_tasks',
    description: 'List tasks for an epic (optionally by status)',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string' },
        status: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { epicId?: string; status?: string[] };
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

      const counts = {
        total: tasks.length,
        backlog: tasks.filter((t) => t.status === 'BACKLOG').length,
        planning: tasks.filter((t) => t.status === 'PLANNING').length,
        awaitingApproval: tasks.filter((t) => t.status === 'AWAITING_APPROVAL').length,
        inProgress: tasks.filter((t) => t.status === 'WORKING').length,
        review: tasks.filter((t) => t.status === 'REVIEW').length,
        done: tasks.filter((t) => t.status === 'DONE').length
      };

      // Build response with explicit null handling
      const response: {
        epicId: string | null;
        epicTitle: string | null;
        epicStatus: string | null;
        tasks: Array<{
          id: string;
          title: string;
          status: string;
          order: number;
          hasWorker: boolean;
          reopenCount: number;
        }>;
        counts: typeof counts;
      } = {
        epicId: epic?.id ?? params.epicId ?? null,
        epicTitle: epic?.title ?? null,
        epicStatus: epic?.status ?? null,
        tasks: sortedTasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          order: t.order,
          hasWorker: Boolean(t.assignedWorkerId),
          reopenCount: t.reopenCount
        })),
        counts
      };

      return response;
    }
  };
}
