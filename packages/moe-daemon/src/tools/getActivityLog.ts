import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidState } from '../util/errors.js';

export function getActivityLogTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_activity_log',
    description: 'Query the activity log for task history, decisions, and events',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Filter by task ID' },
        epicId: { type: 'string', description: 'Filter by epic ID' },
        workerId: { type: 'string', description: 'Filter by worker ID' },
        eventTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by event types (e.g. STEP_COMPLETED, TASK_STATUS_CHANGED)'
        },
        limit: { type: 'number', description: 'Max events to return (default 50)' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      if (!state.project) {
        throw invalidState('Project', 'not loaded', 'loaded');
      }

      const params = (args || {}) as {
        taskId?: string;
        epicId?: string;
        workerId?: string;
        eventTypes?: string[];
        limit?: number;
      };

      const limit = params.limit && params.limit > 0 ? params.limit : 50;

      // Fetch more than requested to account for filtering
      const fetchLimit = params.taskId || params.epicId || params.workerId || params.eventTypes
        ? Math.max(limit * 5, 500)
        : limit;

      let events = state.getActivityLog(fetchLimit);

      // Apply filters
      if (params.taskId) {
        events = events.filter(e => e.taskId === params.taskId);
      }
      if (params.epicId) {
        events = events.filter(e => e.epicId === params.epicId);
      }
      if (params.workerId) {
        events = events.filter(e => e.workerId === params.workerId);
      }
      if (params.eventTypes && params.eventTypes.length > 0) {
        const types = new Set(params.eventTypes);
        events = events.filter(e => types.has(e.event));
      }

      // Apply final limit
      events = events.slice(0, limit);

      return {
        events,
        count: events.length,
        filters: {
          taskId: params.taskId || null,
          epicId: params.epicId || null,
          workerId: params.workerId || null,
          eventTypes: params.eventTypes || null,
          limit
        }
      };
    }
  };
}
