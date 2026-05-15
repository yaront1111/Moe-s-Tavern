import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { sortByOrder } from '../util/order.js';
import {
  DEFAULT_TASK_PREVIEW_CHARS,
  MAX_TASK_PREVIEW_CHARS,
  normalizeIntegerOption,
  normalizeTaskDetailMode,
  taskSummary,
  type TaskDetailMode,
} from '../util/taskPayload.js';

export function getNextTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.get_next_task',
    description: 'Get the next backlog task for an epic',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string' },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'Response detail level. summary returns compact task summary; full returns description and DoD.',
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
        epicId?: string;
        detail?: TaskDetailMode;
        maxDescriptionChars?: number;
      };
      const detail = normalizeTaskDetailMode(params.detail);
      const maxDescriptionChars = normalizeIntegerOption(
        params.maxDescriptionChars,
        'maxDescriptionChars',
        DEFAULT_TASK_PREVIEW_CHARS,
        0,
        MAX_TASK_PREVIEW_CHARS
      );
      const tasks = Array.from(state.tasks.values()).filter((task) => {
        if (params.epicId && task.epicId !== params.epicId) return false;
        return task.status === 'BACKLOG';
      });

      const ordered = sortByOrder(tasks);
      const next = ordered[0];

      if (!next) {
        return { hasNext: false };
      }

      return {
        hasNext: true,
        detail,
        task: detail === 'full'
          ? {
              id: next.id,
              title: next.title,
              description: next.description,
              definitionOfDone: next.definitionOfDone
            }
          : taskSummary(next, {
              includeDescriptionPreview: true,
              maxDescriptionChars,
            })
      };
    }
  };
}
