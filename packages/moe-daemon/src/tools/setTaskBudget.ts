import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { maybeApplyBudgetWarnings } from '../util/budget.js';

export function setTaskBudgetTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.set_task_budget',
    description: 'Set or clear the wall-clock budget on a task. Setting wallClockMs to 0 (or omitting) clears the budget.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        wallClockMs: { type: 'number', description: 'Soft cap in ms on first-claim → DONE. Pass 0 or omit to clear.' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; wallClockMs?: number };
      if (!params.taskId) {
        throw missingRequired('taskId');
      }
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const clearing = params.wallClockMs === undefined
        || params.wallClockMs === null
        || params.wallClockMs === 0;

      if (!clearing) {
        if (typeof params.wallClockMs !== 'number'
            || !Number.isFinite(params.wallClockMs)
            || params.wallClockMs <= 0) {
          throw invalidInput('wallClockMs', 'must be a positive number of milliseconds, or 0 to clear');
        }
      }

      // Preserve any prior warn/escalate marks the daemon has already set
      // when the architect adjusts the cap upward. If they're lowering the
      // cap such that the new threshold has already been crossed, the next
      // hot-path call will catch it via maybeApplyBudgetWarnings.
      let nextBudget: { wallClockMs?: number; warnedAt?: string; escalatedAt?: string } | undefined;
      if (clearing) {
        nextBudget = undefined;
      } else {
        nextBudget = {
          ...(task.budget ?? {}),
          wallClockMs: params.wallClockMs as number,
        };
      }

      const updated = await state.updateTask(params.taskId, { budget: nextBudget });

      // Re-evaluate immediately so an architect who sets a tight budget on an
      // in-flight task gets a warning right now if it's already over threshold.
      const afterCheck = await maybeApplyBudgetWarnings(state, updated);

      return {
        success: true,
        taskId: afterCheck.id,
        budget: afterCheck.budget ?? null,
      };
    }
  };
}
