import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskStatus } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';
import {
  DEFAULT_TASK_PREVIEW_CHARS,
  MAX_TASK_PREVIEW_CHARS,
  normalizeIntegerOption,
  normalizeTaskDetailMode,
  taskSummary,
  type TaskDetailMode,
} from '../util/taskPayload.js';

const DEFAULT_SEARCH_LIMIT = 20;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 200;
const MAX_QUERY_LENGTH = 500;

export function searchTasksTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.search_tasks',
    description: 'Search tasks by query and filters. ARCHIVED tasks are excluded by default — set includeArchived:true or filters.status=ARCHIVED to include them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (searches title and description)'
        },
        filters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE', 'ARCHIVED', 'BLOCKED'],
              description: 'Filter by task status'
            },
            epicId: {
              type: 'string',
              description: 'Filter by epic ID'
            },
            assignedWorkerId: {
              type: 'string',
              description: 'Filter by assigned worker ID'
            }
          },
          description: 'Optional filters'
        },
        includeArchived: {
          type: 'boolean',
          description: 'Include ARCHIVED tasks in results (default false). Shelved tickets stay out of search unless explicitly requested.',
          default: false
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
          default: 20
        },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'Response detail level. summary returns compact task summaries; full returns full task objects.',
          default: 'summary'
        },
        maxDescriptionChars: {
          type: 'number',
          description: 'Maximum description preview length in summary mode (default: 240, max: 2000)',
          default: DEFAULT_TASK_PREVIEW_CHARS
        }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        query?: string;
        filters?: {
          status?: TaskStatus;
          epicId?: string;
          assignedWorkerId?: string;
        };
        includeArchived?: boolean;
        limit?: number;
        detail?: TaskDetailMode;
        maxDescriptionChars?: number;
      };

      if (params.query !== undefined && typeof params.query !== 'string') {
        throw invalidInput('query', 'must be a string');
      }

      if (
        params.limit !== undefined &&
        (typeof params.limit !== 'number' || !Number.isFinite(params.limit))
      ) {
        throw invalidInput('limit', 'must be a finite number');
      }

      const limitInput = params.limit === undefined
        ? DEFAULT_SEARCH_LIMIT
        : Math.trunc(params.limit);
      const limit = Math.max(MIN_SEARCH_LIMIT, Math.min(MAX_SEARCH_LIMIT, limitInput));
      const detail = normalizeTaskDetailMode(params.detail);
      const maxDescriptionChars = normalizeIntegerOption(
        params.maxDescriptionChars,
        'maxDescriptionChars',
        DEFAULT_TASK_PREVIEW_CHARS,
        0,
        MAX_TASK_PREVIEW_CHARS
      );

      const queryValue = params.query === undefined
        ? null
        : params.query.slice(0, MAX_QUERY_LENGTH);
      const query = queryValue?.toLowerCase() ?? '';
      const filters = params.filters ?? {};

      const snapshot = state.getSnapshot();
      let results = snapshot.tasks;

      // Shelve ARCHIVED tasks out of search results unless the caller opts in
      // (includeArchived, or an explicit ARCHIVED status filter). Keeps archived
      // tickets out of agent context by default.
      const showArchived = params.includeArchived === true || filters.status === 'ARCHIVED';
      if (!showArchived) {
        results = results.filter(t => t.status !== 'ARCHIVED');
      }

      // Apply filters
      if (filters.status) {
        results = results.filter(t => t.status === filters.status);
      }
      if (filters.epicId) {
        results = results.filter(t => t.epicId === filters.epicId);
      }
      if (filters.assignedWorkerId) {
        results = results.filter(t => t.assignedWorkerId === filters.assignedWorkerId);
      }

      // Apply search query
      if (query) {
        results = results
          .map(task => {
            const titleMatch = task.title.toLowerCase().includes(query);
            const descMatch = task.description.toLowerCase().includes(query);
            const titleScore = titleMatch ? 2 : 0; // Title matches are more relevant
            const descScore = descMatch ? 1 : 0;
            return { task, score: titleScore + descScore };
          })
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(item => item.task);
      }

      // Capture total before limiting
      const totalMatches = results.length;

      // Apply limit
      results = results.slice(0, limit);

      return {
        tasks: detail === 'full'
          ? results
          : results.map(task => taskSummary(task, {
              includeDescriptionPreview: true,
              maxDescriptionChars,
            })),
        totalMatches,
        query: queryValue,
        filters,
        detail
      };
    }
  };
}
