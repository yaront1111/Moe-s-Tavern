import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ActivityEvent } from '../types/schema.js';
import { invalidInput, invalidState } from '../util/errors.js';

export const ACTIVITY_LOG_DEFAULT_LIMIT = 10;
export const ACTIVITY_LOG_MAX_LIMIT = 100;
export const ACTIVITY_LOG_DEFAULT_MAX_PAYLOAD_CHARS = 500;
export const ACTIVITY_LOG_MAX_PAYLOAD_CHARS = 2000;
export const ACTIVITY_LOG_MAX_OFFSET = 10000;
export const ACTIVITY_LOG_FILTER_SCAN_LIMIT = 5000;

interface ActivityLogParams {
  taskId?: string;
  epicId?: string;
  workerId?: string;
  eventTypes?: string[];
  limit?: number;
  offset?: number;
  maxPayloadChars?: number;
}

interface NormalizedActivityLogParams {
  taskId?: string;
  epicId?: string;
  workerId?: string;
  eventTypes?: string[];
  limit: number;
  offset: number;
  maxPayloadChars: number;
}

function normalizeNumberParam(
  params: ActivityLogParams,
  field: 'limit' | 'offset' | 'maxPayloadChars',
  defaultValue: number,
  minValue: number,
  maxValue: number
): number {
  const value = params[field];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput(field, 'must be a finite number');
  }

  const truncated = Math.trunc(value);
  if (truncated < minValue) {
    throw invalidInput(field, `must be at least ${minValue}`);
  }
  return Math.min(truncated, maxValue);
}

export function normalizeActivityLogParams(args: unknown): NormalizedActivityLogParams {
  const params = (args || {}) as ActivityLogParams;
  if (params.eventTypes !== undefined) {
    if (!Array.isArray(params.eventTypes)) {
      throw invalidInput('eventTypes', 'must be an array of strings');
    }
    if (params.eventTypes.length > 50) {
      throw invalidInput('eventTypes', 'too many items (max 50)');
    }
    for (const eventType of params.eventTypes) {
      if (typeof eventType !== 'string' || eventType.trim().length === 0) {
        throw invalidInput('eventTypes', 'items must be non-empty strings');
      }
    }
  }

  return {
    taskId: params.taskId,
    epicId: params.epicId,
    workerId: params.workerId,
    eventTypes: params.eventTypes,
    limit: normalizeNumberParam(params, 'limit', ACTIVITY_LOG_DEFAULT_LIMIT, 1, ACTIVITY_LOG_MAX_LIMIT),
    offset: normalizeNumberParam(params, 'offset', 0, 0, ACTIVITY_LOG_MAX_OFFSET),
    maxPayloadChars: normalizeNumberParam(
      params,
      'maxPayloadChars',
      ACTIVITY_LOG_DEFAULT_MAX_PAYLOAD_CHARS,
      0,
      ACTIVITY_LOG_MAX_PAYLOAD_CHARS
    ),
  };
}

/**
 * Truncate large payload values to prevent oversized MCP responses.
 * Never throws — returns original event on error.
 */
export function truncateActivityPayload(event: ActivityEvent, maxChars: number): ActivityEvent {
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

export function queryActivityLog(state: StateManager, params: NormalizedActivityLogParams) {
  const hasFilters = !!(params.taskId || params.epicId || params.workerId || params.eventTypes?.length);
  const requestedWindow = params.offset + params.limit + 1;
  const fetchLimit = hasFilters ? ACTIVITY_LOG_FILTER_SCAN_LIMIT : requestedWindow;

  const scanned = state.getActivityLogWindow(fetchLimit);
  let events = scanned.events;

  if (params.taskId) {
    events = events.filter(e => e.taskId === params.taskId);
  }
  if (params.epicId) {
    events = events.filter(e => e.epicId === params.epicId);
  }
  if (params.workerId) {
    events = events.filter(e => e.workerId === params.workerId);
  }
  if (params.eventTypes?.length) {
    const types = new Set(params.eventTypes);
    events = events.filter(e => types.has(e.event));
  }

  const matchingWithinScan = events.length;
  const hasMore = matchingWithinScan > params.offset + params.limit || scanned.hasMoreOlderLines;
  events = events
    .slice(params.offset, params.offset + params.limit)
    .map(e => truncateActivityPayload(e, params.maxPayloadChars));

  return {
    events,
    count: events.length,
    hasMore,
    filters: {
      taskId: params.taskId || null,
      epicId: params.epicId || null,
      workerId: params.workerId || null,
      eventTypes: params.eventTypes || null,
      limit: params.limit,
      offset: params.offset,
      maxPayloadChars: params.maxPayloadChars,
    },
    pagination: {
      limit: params.limit,
      offset: params.offset,
      returned: events.length,
      hasMore,
    },
    search: {
      scannedEvents: scanned.events.length,
      scannedLines: scanned.linesRead,
      scanLimit: fetchLimit,
      matchingEventsWithinScan: matchingWithinScan,
      complete: !scanned.hasMoreOlderLines,
    },
  };
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
        limit: { type: 'number', description: `Max events to return (default ${ACTIVITY_LOG_DEFAULT_LIMIT}, max ${ACTIVITY_LOG_MAX_LIMIT}). Narrow with taskId/epicId/eventTypes for cheaper queries.` },
        offset: { type: 'number', description: `Skip first N matching events (default 0, max ${ACTIVITY_LOG_MAX_OFFSET})` },
        maxPayloadChars: { type: 'number', description: `Max chars per event payload value (default ${ACTIVITY_LOG_DEFAULT_MAX_PAYLOAD_CHARS}, max ${ACTIVITY_LOG_MAX_PAYLOAD_CHARS}, 0 = no truncation)` }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      if (!state.project) {
        throw invalidState('Project', 'not loaded', 'loaded');
      }

      return queryActivityLog(state, normalizeActivityLogParams(args));
    }
  };
}
