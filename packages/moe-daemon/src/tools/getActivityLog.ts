import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ActivityEvent } from '../types/schema.js';
import { invalidState } from '../util/errors.js';

/**
 * Truncate large payload values to prevent oversized MCP responses.
 * Never throws — returns original event on error.
 */
function truncatePayload(event: ActivityEvent, maxChars: number): ActivityEvent {
  if (maxChars <= 0) return event;

  try {
    const truncated = { ...event, payload: { ...event.payload } };

    for (const [key, value] of Object.entries(truncated.payload)) {
      if (typeof value === 'string') {
        if (value.length > maxChars) {
          truncated.payload[key] = value.slice(0, maxChars) + ' [truncated]';
        }
      } else if (value !== null && value !== undefined && typeof value === 'object') {
        const serialized = JSON.stringify(value);
        if (serialized.length > maxChars) {
          truncated.payload[key] = serialized.slice(0, maxChars) + ' [truncated]';
        }
      }
    }

    return truncated;
  } catch {
    return event;
  }
}

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
        limit: { type: 'number', description: 'Max events to return (default 50)' },
        offset: { type: 'number', description: 'Skip first N events (for pagination, default 0)' },
        maxPayloadChars: { type: 'number', description: 'Max chars per event payload value (default 500, 0 = no limit)' }
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
        offset?: number;
        maxPayloadChars?: number;
      };

      const limit = params.limit && params.limit > 0 ? params.limit : 50;
      const offset = params.offset && params.offset > 0 ? params.offset : 0;
      const maxPayloadChars = params.maxPayloadChars !== undefined ? params.maxPayloadChars : 500;

      // Fetch more than requested to account for filtering, but cap the pre-fetch
      const hasFilters = !!(params.taskId || params.epicId || params.workerId || params.eventTypes);
      const fetchLimit = hasFilters
        ? Math.min(Math.max((limit + offset) * 5, 100), 1000)
        : limit + offset + 1;

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

      // Check if there are more events beyond our window
      const totalFiltered = events.length;
      const hasMore = totalFiltered > offset + limit;

      // Apply offset and limit
      events = events.slice(offset, offset + limit);

      // Truncate large payloads
      if (maxPayloadChars > 0) {
        events = events.map(e => truncatePayload(e, maxPayloadChars));
      }

      return {
        events,
        count: events.length,
        hasMore,
        filters: {
          taskId: params.taskId || null,
          epicId: params.epicId || null,
          workerId: params.workerId || null,
          eventTypes: params.eventTypes || null,
          limit,
          offset
        }
      };
    }
  };
}
