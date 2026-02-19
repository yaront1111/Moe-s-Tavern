import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskStatus } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';

const DEFAULT_SEARCH_LIMIT = 20;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 200;
const MAX_QUERY_LENGTH = 500;

export function searchTasksTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.search_tasks',
    description: 'Search tasks by query and filters',
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
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
          default: 20
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
        limit?: number;
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

      const queryValue = params.query === undefined
        ? null
        : params.query.slice(0, MAX_QUERY_LENGTH);
      const query = queryValue?.toLowerCase() ?? '';
      const filters = params.filters ?? {};

      const snapshot = state.getSnapshot();
      let results = snapshot.tasks;

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
        tasks: results,
        totalMatches,
        query: queryValue,
        filters
      };
    }
  };
}
