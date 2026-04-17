import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage, TaskPriority } from '../types/schema.js';
import { missingRequired } from '../util/errors.js';
import { logger } from '../util/logger.js';

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface ActiveWaiter {
  resolve: (value: unknown) => void;
  unsubscribe: () => void;
  timer: NodeJS.Timeout;
}

/** Map of workerId -> active waiter. Exported for disconnect cleanup. */
export const activeWaiters = new Map<string, ActiveWaiter>();

/**
 * Remove stale waiters for workers that no longer exist in memory.
 * Returns number of removed waiters.
 */
export function cleanupStaleWaiters(state: StateManager): number {
  let cleaned = 0;

  for (const [workerId, waiter] of activeWaiters.entries()) {
    if (state.workers.has(workerId)) {
      continue;
    }

    try {
      clearTimeout(waiter.timer);
    } catch (error) {
      logger.warn({ workerId, error }, 'Failed to clear stale waiter timeout');
    }

    try {
      waiter.unsubscribe();
    } catch (error) {
      logger.warn({ workerId, error }, 'Failed to unsubscribe stale waiter');
    }

    try {
      waiter.resolve({ hasNext: false, cancelled: true });
    } catch (error) {
      logger.warn({ workerId, error }, 'Failed to resolve stale waiter');
    }

    activeWaiters.delete(workerId);
    cleaned += 1;
  }

  return cleaned;
}

function findPendingQuestion(
  state: StateManager,
  epicId?: string
): { taskId: string; title: string; status: string; epicId: string } | null {
  for (const task of state.tasks.values()) {
    if (!task.hasPendingQuestion) continue;
    if (epicId && task.epicId !== epicId) continue;
    return { taskId: task.id, title: task.title, status: task.status, epicId: task.epicId };
  }
  return null;
}

function findMatchingTask(
  state: StateManager,
  statuses: string[],
  epicId?: string
): { id: string; title: string; status: string; priority: string; epicId: string } | null {
  const tasks = Array.from(state.tasks.values())
    .filter((t) => statuses.includes(t.status))
    .filter((t) => (epicId ? t.epicId === epicId : true))
    .filter((t) => !t.assignedWorkerId)
    .sort((a, b) => {
      const pa = PRIORITY_WEIGHT[a.priority] ?? PRIORITY_WEIGHT.MEDIUM;
      const pb = PRIORITY_WEIGHT[b.priority] ?? PRIORITY_WEIGHT.MEDIUM;
      if (pa !== pb) return pa - pb;
      return a.order - b.order;
    });

  const task = tasks[0];
  if (!task) return null;
  return { id: task.id, title: task.title, status: task.status, priority: task.priority, epicId: task.epicId };
}

export function waitForTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.wait_for_task',
    description: 'Block until a claimable task matching the given statuses appears. Returns immediately if one already exists. Does NOT claim the task - call moe.claim_next_task after waking.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { type: 'string' }, description: 'Task statuses to watch for' },
        workerId: { type: 'string', description: 'Your worker ID (used for cleanup on disconnect)' },
        epicId: { type: 'string', description: 'Optional epic filter' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default 300000, max 600000)' }
      },
      required: ['statuses', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { statuses?: string[]; workerId?: string; epicId?: string; timeoutMs?: number };
      const statuses = params.statuses || [];
      if (statuses.length === 0) {
        throw missingRequired('statuses');
      }
      const workerId = params.workerId;
      if (!workerId) {
        throw missingRequired('workerId');
      }

      // Cancel any existing waiter for this worker
      const existing = activeWaiters.get(workerId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.unsubscribe();
        existing.resolve({ hasNext: false, cancelled: true });
        activeWaiters.delete(workerId);
      }

      // Check if a matching task already exists
      const immediate = findMatchingTask(state, statuses, params.epicId);
      if (immediate) {
        return {
          hasNext: true,
          task: immediate,
          nextAction: {
            tool: 'moe.claim_next_task',
            args: { statuses, workerId, epicId: params.epicId },
            reason: 'Task is available; claim it, then call moe.get_context.'
          }
        };
      }

      // Check if any task has a pending question
      const pendingQ = findPendingQuestion(state, params.epicId);
      if (pendingQ) {
        return {
          hasNext: false,
          hasPendingQuestion: true,
          taskId: pendingQ.taskId,
          nextAction: {
            tool: 'moe.get_pending_questions',
            args: {},
            reason: 'A task has an unanswered human question; read and answer with moe.add_comment before claiming.'
          }
        };
      }

      const timeoutMs = Math.min(
        Math.max(params.timeoutMs || DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS
      );

      logger.info({ workerId, statuses, epicId: params.epicId, timeoutMs }, 'Worker waiting for task');

      return new Promise<unknown>((resolve) => {
        // Use let + nullable refs so cleanup() is safe whether called before or
        // after state.subscribe assigns `unsubscribe`. Guards against the race
        // where state.subscribe throws synchronously: without this, the timer
        // would remain scheduled for up to timeoutMs and its callback would
        // then ReferenceError trying to use an unassigned `unsubscribe`.
        let cleanedUp = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;

        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (timer) clearTimeout(timer);
          if (unsubscribe) {
            try { unsubscribe(); } catch { /* already torn down */ }
          }
          activeWaiters.delete(workerId);
        };

        timer = setTimeout(() => {
          cleanup();
          logger.info({ workerId }, 'Wait for task timed out');
          resolve({
            hasNext: false,
            timedOut: true,
            nextAction: {
              tool: 'moe.wait_for_task',
              args: { statuses, workerId, epicId: params.epicId, timeoutMs },
              reason: 'Timeout elapsed; re-enter wait to keep listening.'
            }
          });
        }, timeoutMs);

        // Don't prevent process exit
        if (timer.unref) {
          timer.unref();
        }

        try {
          unsubscribe = state.subscribe((event) => {
          // Wake on chat messages targeting this worker
          if (event.type === 'MESSAGE_CREATED') {
            const message = event.payload as ChatMessage;
            const targets = (event as { routingTargets?: string[] }).routingTargets ?? message.mentions ?? [];
            if (targets.includes(workerId) || message.sender === 'human') {
              cleanup();
              logger.info({ workerId, channel: message.channel, sender: message.sender }, 'Chat message received, waking worker');
              resolve({
                hasNext: false,
                hasChatMessage: true,
                chatMessage: {
                  channel: message.channel,
                  sender: message.sender,
                  preview: message.content.substring(0, 200)
                },
                nextAction: {
                  tool: 'moe.chat_read',
                  args: { channel: message.channel, workerId },
                  reason: 'Incoming chat mention; read and respond, then call moe.wait_for_task again.'
                }
              });
            }
            return;
          }

          // Only react to task creation/update events
          if (event.type !== 'TASK_CREATED' && event.type !== 'TASK_UPDATED') return;

          const match = findMatchingTask(state, statuses, params.epicId);
          if (match) {
            cleanup();
            logger.info({ workerId, taskId: match.id }, 'Task available, waking worker');
            resolve({
              hasNext: true,
              task: match,
              nextAction: {
                tool: 'moe.claim_next_task',
                args: { statuses, workerId, epicId: params.epicId },
                reason: 'Matching task appeared; claim it, then call moe.get_context.'
              }
            });
            return;
          }

          // Check if a task now has a pending question
          if (event.type === 'TASK_UPDATED' && (event.payload as { hasPendingQuestion?: boolean }).hasPendingQuestion) {
            const pq = findPendingQuestion(state, params.epicId);
            if (pq) {
              cleanup();
              logger.info({ workerId, taskId: pq.taskId }, 'Pending question detected, waking worker');
              resolve({
                hasNext: false,
                hasPendingQuestion: true,
                taskId: pq.taskId,
                nextAction: {
                  tool: 'moe.get_pending_questions',
                  args: {},
                  reason: 'A task has an unanswered human question; read and reply via moe.add_comment.'
                }
              });
            }
          }
          });
        } catch (err) {
          cleanup();
          logger.error({ workerId, err }, 'Failed to subscribe in wait_for_task');
          resolve({ hasNext: false, error: 'subscribe_failed' });
          return;
        }

        // Register entry so cleanupMcpWorkers and the "cancel existing waiter" path
        // at L122 can find and release it. unsubscribe is guaranteed non-null here.
        activeWaiters.set(workerId, {
          resolve,
          unsubscribe: () => cleanup(),
          timer: timer!
        });
      });
    }
  };
}
