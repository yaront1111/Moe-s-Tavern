// =============================================================================
// Activity log - append, flush and bounded tail reads
// =============================================================================
//
// Extracted verbatim from StateManager. Every function takes the StateManager
// handle so the backpressure counters (pendingActivityWrites,
// droppedActivityWrites, lastActivityBackpressureWarn, activityFlushResolvers)
// stay single-copy on the instance - shadowing any of them in module scope
// would silently split the accounting and break flushActivityLog's wait.
//
// Error handling: activity logging is best-effort by contract. appendActivity
// must never throw into its caller - a failed audit write must not fail the
// state mutation that triggered it - and getActivityLogWindow returns an empty
// window rather than throwing when activity.log is missing or truncated
// mid-line.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import type { ActivityEvent, ActivityEventType, Epic, RailProposal, Task, Worker } from '../types/schema.js';
import { ACTIVITY_EVENT_TYPES } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { readLastLinesWithMetadata } from '../util/reverseReader.js';

/**
 * Append activity to the activity log.
 * This is fire-and-forget but uses mutex for ordering.
 */
export function appendActivity(state: StateManager,
  event: ActivityEventType,
  payload: Record<string, unknown>,
  task?: Task,
  worker?: Worker,
  proposal?: RailProposal,
  epic?: Epic
): void {
  // Backpressure: if the activity write queue is unbounded, drop new writes
  // and warn at most once every 30 s so the log doesn't spam either.
  if (state.pendingActivityWrites > 1000) {
    state.droppedActivityWrites++;
    const now = Date.now();
    if (now - state.lastActivityBackpressureWarn > 30_000) {
      logger.warn(
        {
          pending: state.pendingActivityWrites,
          dropped: state.droppedActivityWrites,
          event
        },
        'Activity log backpressure: dropping writes'
      );
      state.lastActivityBackpressureWarn = now;
      state.droppedActivityWrites = 0;
    }
    return;
  }

  // Track pending writes so flush can wait for all writes to complete
  state.pendingActivityWrites++;

  if (!state.project) {
    state.pendingActivityWrites--;
    notifyActivityFlushed(state);
    return;
  }

  const activity: ActivityEvent = {
    id: generateId('evt'),
    timestamp: new Date().toISOString(),
    projectId: state.project.id,
    epicId: task?.epicId || epic?.id,
    taskId: task?.id,
    workerId: worker?.id || proposal?.workerId,
    event,
    payload
  };

  const logPath = path.join(state.moePath, 'activity.log');
  const line = `${JSON.stringify(activity)}\n`;

  // Fire-and-forget but serialized through mutex
  // We don't await here intentionally - activity logging shouldn't block operations
  void state.activityMutex.runExclusive(async () => {
    try {
      // Rotate log if needed before appending
      if (state.logRotator) {
        await state.logRotator.rotateIfNeeded();
      }
      fs.appendFileSync(logPath, line, { flag: 'a' });
    } catch (error) {
      logger.error({ error }, 'Failed to append activity log');
    } finally {
      state.pendingActivityWrites--;
      notifyActivityFlushed(state);
    }
  });
}

/**
 * Append activity and wait for it to complete.
 * Use this when you need to ensure the activity is persisted before continuing.
 */
export async function appendActivityAsync(state: StateManager,
  event: ActivityEventType,
  payload: Record<string, unknown>,
  task?: Task,
  worker?: Worker,
  proposal?: RailProposal,
  epic?: Epic
): Promise<void> {
  if (!state.project) return;

  const activity: ActivityEvent = {
    id: generateId('evt'),
    timestamp: new Date().toISOString(),
    projectId: state.project.id,
    epicId: task?.epicId || epic?.id,
    taskId: task?.id,
    workerId: worker?.id || proposal?.workerId,
    event,
    payload
  };

  const logPath = path.join(state.moePath, 'activity.log');
  const line = `${JSON.stringify(activity)}\n`;

  await state.activityMutex.runExclusive(async () => {
    try {
      fs.appendFileSync(logPath, line, { flag: 'a' });
    } catch (error) {
      logger.error({ error }, 'Failed to append activity log');
    }
  });
}

/**
 * Validates that an object is a valid ActivityEvent.
 * Returns null if valid, or an error message if invalid.
 */
export function validateActivityEvent(state: StateManager, obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') {
    return 'Not an object';
  }
  const event = obj as Record<string, unknown>;

  // Check required string fields
  if (typeof event.id !== 'string' || !event.id) {
    return 'Missing or invalid id';
  }
  if (typeof event.timestamp !== 'string' || !event.timestamp) {
    return 'Missing or invalid timestamp';
  }
  if (typeof event.projectId !== 'string' || !event.projectId) {
    return 'Missing or invalid projectId';
  }

  // Check event type is valid
  if (typeof event.event !== 'string' || !ACTIVITY_EVENT_TYPES.includes(event.event as ActivityEventType)) {
    return `Invalid event type: ${event.event}`;
  }

  // Check payload is an object
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return 'Missing or invalid payload';
  }

  // Optional fields - validate type if present
  if (event.epicId !== undefined && typeof event.epicId !== 'string') {
    return 'Invalid epicId type';
  }
  if (event.taskId !== undefined && typeof event.taskId !== 'string') {
    return 'Invalid taskId type';
  }
  if (event.workerId !== undefined && typeof event.workerId !== 'string') {
    return 'Invalid workerId type';
  }

  return null;
}

/**
 * Read activity log entries.
 * Returns events in reverse chronological order (newest first).
 * Invalid entries are skipped with a warning log.
 */
export function getActivityLog(state: StateManager, limit = 100): ActivityEvent[] {
  return getActivityLogWindow(state, limit).events;
}

/**
 * Read a bounded activity log tail and report whether older raw log lines were omitted.
 * Returns events in reverse chronological order (newest first).
 */
export function getActivityLogWindow(state: StateManager, limit = 100): { events: ActivityEvent[]; hasMoreOlderLines: boolean; linesRead: number } {
  const logPath = path.join(state.moePath, 'activity.log');
  if (!fs.existsSync(logPath)) {
    return { events: [], hasMoreOlderLines: false, linesRead: 0 };
  }

  try {
    const safeLimit = Math.max(0, Math.trunc(limit));
    if (safeLimit === 0) {
      return { events: [], hasMoreOlderLines: false, linesRead: 0 };
    }

    const { lines, hasMoreOlderLines } = readLastLinesWithMetadata(logPath, safeLimit);
    const events: ActivityEvent[] = [];
    let skippedCount = 0;

    for (const line of lines) {
      try {
        // Try to parse as JSON (new format)
        if (line.startsWith('{')) {
          const parsed = JSON.parse(line);
          const validationError = validateActivityEvent(state, parsed);
          if (validationError) {
            skippedCount++;
            logger.warn({ error: validationError, linePreview: line.substring(0, 100) }, 'Skipping invalid activity log entry');
            continue;
          }
          events.push(parsed as ActivityEvent);
        }
        // Skip old format lines for now
      } catch (parseError) {
        skippedCount++;
        logger.warn({ linePreview: line.substring(0, 50) }, 'Skipping malformed activity log entry');
      }
    }

    if (skippedCount > 0) {
      logger.info({ skippedCount, totalLines: lines.length }, 'Activity log parsing completed with skipped entries');
    }

    // readLastLines returns chronological order within the tail window.
    // Convert to reverse chronological order for API compatibility.
    return {
      events: events.reverse().slice(0, safeLimit),
      hasMoreOlderLines,
      linesRead: lines.length,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to read activity log');
    return { events: [], hasMoreOlderLines: false, linesRead: 0 };
  }
}

/**
 * Wait for all pending activity log writes to complete.
 * Call this during shutdown to ensure no events are lost.
 */
export async function flushActivityLog(state: StateManager): Promise<void> {
  if (state.pendingActivityWrites === 0) {
    return;
  }
  const FLUSH_TIMEOUT_MS = 5000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Safety timeout — don't block shutdown forever
      const idx = state.activityFlushResolvers.indexOf(resolve);
      if (idx >= 0) state.activityFlushResolvers.splice(idx, 1);
      logger.warn({ pending: state.pendingActivityWrites }, 'Activity log flush timed out');
      resolve();
    }, FLUSH_TIMEOUT_MS);
    state.activityFlushResolvers.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** @internal — reached by the extracted state/* modules; not part of the supported API. */
export function notifyActivityFlushed(state: StateManager): void {
  if (state.pendingActivityWrites === 0) {
    const resolvers = state.activityFlushResolvers;
    state.activityFlushResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }
}
