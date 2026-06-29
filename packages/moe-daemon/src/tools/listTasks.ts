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
    description: 'List tasks for an epic (optionally by status). ARCHIVED tasks are hidden by default — pass includeArchived:true or name ARCHIVED in status to see them. counts.archived always reflects the true total.',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string' },
        status: { type: 'array', items: { type: 'string' } },
        includeArchived: {
          type: 'boolean',
          description: 'Include ARCHIVED tasks in the returned list (default false). ARCHIVED tasks are shelved out of context unless explicitly requested.',
          default: false
        },
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
      const params = (args || {}) as { epicId?: string; status?: string[]; includeArchived?: boolean; limit?: number; offset?: number };

      // ARCHIVED tasks stay out of the returned list (and therefore out of agent
      // context) unless the caller opts in — either explicitly via
      // includeArchived, or by naming ARCHIVED in the status filter. The
      // counts.archived field below still reports the true total regardless, so
      // the existence of shelved tickets is never hidden, only their bulk.
      const statusFilter = params.status && params.status.length > 0 ? params.status : null;
      const showArchived = params.includeArchived === true || (statusFilter?.includes('ARCHIVED') ?? false);
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
        if (task.status === 'ARCHIVED' && !showArchived) return false;
        if (statusFilter) {
          return statusFilter.includes(task.status);
        }
        return true;
      });

      const epic = params.epicId ? state.getEpic(params.epicId) : null;

      // Sort tasks by order for consistent output
      const sortedTasks = [...tasks].sort((a, b) => a.order - b.order);
      const pagedTasks = sortedTasks.slice(offset, offset + limit);

      // counts.archived must report the true epic-scoped total even when the
      // archived tasks themselves are hidden from the returned list — otherwise
      // hiding them would also hide the fact that they exist.
      const archivedTotal = Array.from(state.tasks.values()).filter(
        (t) => (!params.epicId || t.epicId === params.epicId) && t.status === 'ARCHIVED'
      ).length;

      const counts = {
        total: tasks.length,
        backlog: tasks.filter((t) => t.status === 'BACKLOG').length,
        planning: tasks.filter((t) => t.status === 'PLANNING').length,
        awaitingApproval: tasks.filter((t) => t.status === 'AWAITING_APPROVAL').length,
        inProgress: tasks.filter((t) => t.status === 'WORKING').length,
        review: tasks.filter((t) => t.status === 'REVIEW').length,
        done: tasks.filter((t) => t.status === 'DONE').length,
        archived: archivedTotal
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
