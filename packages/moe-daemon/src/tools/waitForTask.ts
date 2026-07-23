import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage, TaskPriority } from '../types/schema.js';
import { missingRequired } from '../util/errors.js';
import { AGENT_CLAIMABLE_STATUSES, assertAgentClaimableStatuses } from '../util/claimableStatuses.js';
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
    // Mirror get_pending_questions' filters — anything visible here but
    // filtered there spins every idle agent in a hot wait→get→wait loop with
    // zero progress. (1) Archiving does not clear hasPendingQuestion, and
    // get_pending_questions skips ARCHIVED. (2) It also only surfaces human
    // comments AFTER the last agent comment — a flag left set after an agent
    // already answered yields an empty result there.
    if (task.status === 'ARCHIVED') continue;
    if (epicId && task.epicId !== epicId) continue;
    const comments = task.comments || [];
    let lastAgentIdx = -1;
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].author !== 'human') {
        lastAgentIdx = i;
        break;
      }
    }
    const hasUnansweredHumanComment = comments
      .slice(lastAgentIdx + 1)
      .some((c) => c.author === 'human');
    if (!hasUnansweredHumanComment) continue;
    return { taskId: task.id, title: task.title, status: task.status, epicId: task.epicId };
  }
  return null;
}

function findMatchingTask(
  state: StateManager,
  statuses: string[],
  epicId?: string,
  workerId?: string
): { id: string; title: string; status: string; priority: string; epicId: string } | null {
  // Eligibility here must be at least as strict as claim_next_task's ranked
  // pool: any task that is wait-visible but claim-ineligible wakes the waiter
  // into a claim that declines straight back to wait_for_task — a hot
  // wake→claim→wait spin at full RPC speed for as long as the task persists.
  const tasks = Array.from(state.tasks.values())
    .filter((t) => statuses.includes(t.status))
    .filter((t) => (epicId ? t.epicId === epicId : true))
    .filter((t) => state.isTaskClaimable(t))
    // A REVIEW task parked for a human (qa_reject hard cap) is excluded from
    // the QA claim queue until a human clears it — mirror that here.
    .filter((t) => !(t.status === 'REVIEW' && t.needsHumanReview === true))
    // Single-worker-per-epic-status (solo workers only): claim skips a
    // candidate when a live OTHER worker holds a different task in the same
    // epic+status — mirror that too.
    .filter((t) => {
      if (!workerId || state.getTeamForWorker(workerId)) return true;
      const otherActiveOnSameStatus = Array.from(state.tasks.values()).some((o) =>
        o.id !== t.id &&
        o.epicId === t.epicId &&
        o.status === t.status &&
        o.assignedWorkerId &&
        o.assignedWorkerId !== workerId &&
        !state.isTaskAssignedToInactiveWorker(o)
      );
      return !otherActiveOnSameStatus;
    })
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
    blocking: true,
    description: 'Block until a claimable task matching the given statuses appears. Returns immediately if one already exists. Does NOT claim the task - call moe.claim_next_task after waking.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: [...AGENT_CLAIMABLE_STATUSES] },
          description: 'Task statuses to watch for. Only PLANNING/WORKING/REVIEW are agent-claimable — waiting on a human-gated column would wake into a claim that is rejected.'
        },
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
      // Same vocabulary as claim_next_task: a waiter on a human-gated column
      // would either sleep forever or wake into a claim that is rejected.
      assertAgentClaimableStatuses(statuses);
      const workerId = params.workerId;
      if (!workerId) {
        throw missingRequired('workerId');
      }
      await state.touchWorker(workerId);

      // Cancel any existing waiter for this worker
      const existing = activeWaiters.get(workerId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.unsubscribe();
        existing.resolve({ hasNext: false, cancelled: true });
        activeWaiters.delete(workerId);
      }

      // Check if a matching task already exists
      const immediate = findMatchingTask(state, statuses, params.epicId, workerId);
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
          void state.touchWorker(workerId)
            .catch((error) => logger.warn({ workerId, error }, 'Failed to refresh worker heartbeat on wait_for_task timeout'))
            .finally(() => {
              resolve({
                hasNext: false,
                timedOut: true,
                nextAction: {
                  tool: 'moe.wait_for_task',
                  args: { statuses, workerId, epicId: params.epicId, timeoutMs },
                  reason: 'Timeout elapsed; re-enter wait to keep listening.'
                }
              });
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

          const match = findMatchingTask(state, statuses, params.epicId, workerId);
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
